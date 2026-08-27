import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict,
  WORKTREE_CREATE_DEDUPE_TTL_MS
} from '../../../src/shared/new-workspace/worktree-create-retry-policy'
import { WORKTREE_CREATE_TIMEOUT_MS } from './workspace-create-timeout'

// Why: server-side collision checks (branch already exists locally / on a remote
// / already has PR #N) can fire even after a pre-flight basename dedupe —
// branches outlive worktrees in git, and remote branches/PRs aren't visible from
// worktree.ps. Retry by appending -2, -3, ... mirroring the desktop createWorktree
// loop in src/renderer/src/store/slices/worktrees.ts.
export type WorktreeCreateResult = { worktreeId: string; name: string } | { error: string }

// Why: a create in flight when the mobile transport migrates (relay/direct
// hand-off on shoddy cellular, relay lease rotation) rejects with a cutover error
// even though the host may have completed it. The shared clientMutationId makes a
// retry idempotent, so re-issue on the fresh session a bounded number of times
// instead of surfacing "RPC interrupted by connection migration" with the
// worktree silently created.
const WORKTREE_CREATE_CUTOVER_MAX_RETRIES = 5

// Why: a connection migration is not the only way a create goes delivery-ambiguous.
// A plain socket close (cellular flap, relay drop, the phone backgrounding and the
// supervisor suspending a billed relay splice) rejects the in-flight frame as
// delivery-unknown with no generation bump, and create holds the longest budget of
// any mobile RPC — 10 minutes of clone/fetch/setup — so it is the likeliest request
// to be caught by one. Surfacing that as a failure is wrong: the host may well have
// finished the worktree. Replay on the same clientMutationId instead.
const WORKTREE_CREATE_AMBIGUOUS_MAX_RETRIES = 2

// Why: the host keeps a settled create's dedupe record for WORKTREE_CREATE_DEDUPE_TTL_MS
// after it resolves; a replay that lands later misses it and the host's suffix loop
// builds a SECOND worktree — and for folder workspaces a second one with the SAME name
// and no collision check at all. So a replay is bounded by how stale our knowledge of the
// host is, and that has to be measured in WALL CLOCK: iOS/Android suspend JS timers while
// the app is backgrounded, so any ceiling derived from timer intervals — a watchdog probe
// budget, a request timeout — can be arbitrarily wrong across a background cycle, which is
// exactly when a create sits ambiguous for minutes.
const WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS = 10_000
export const WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS =
  WORKTREE_CREATE_DEDUPE_TTL_MS - WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS
// Bounded so the Create spinner doesn't sit for the whole window; the deadline still caps it.
export const WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS = 20_000

export type CreateWorktreeWithNameRetryArgs = {
  client: RpcClient
  baseName: string
  nameWasGenerated?: boolean
  buildParams: (name: string) => Record<string, unknown>
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
  maxAttempts?: number
  // Injected in tests; production mints a fresh idempotency key per candidate.
  mintMutationId?: () => string
}

// Creates a worktree, retrying with a numeric suffix on a name-collision error.
// buildParams receives the candidate name so callers can assemble source-specific
// params (linked issue/PR, base branch, etc.) around it. Callers that can't clear
// a collision by re-suffixing (e.g. reusing a fixed existing branch) pass
// maxAttempts: 1 to fail fast instead of burning the full retry budget.
export async function createWorktreeWithNameRetry(
  args: CreateWorktreeWithNameRetryArgs
): Promise<WorktreeCreateResult> {
  const { client, baseName, buildParams } = args
  // Why: creating before status.get settles would silently disable safe replay
  // during the exact slow-network window this path is meant to recover from.
  const supportsIdempotentCutoverRetry = await args.supportsIdempotentCutoverRetry
  const maxAttempts = args.maxAttempts ?? CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS
  const mintMutationId = args.mintMutationId ?? defaultWorktreeCreateMutationId
  let lastError: string | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateName = args.nameWasGenerated
      ? getGeneratedWorktreeCreateRetryCandidate(baseName, attempt)
      : getClientWorktreeCreateCandidate(baseName, attempt)
    const candidateParams = buildParams(candidateName)
    // Why: older hosts strip unknown fields, so only stamp and replay when the
    // host advertises idempotency. One key per candidate makes cutover retries
    // safe while a name-collision bump remains a genuinely new create.
    const params = supportsIdempotentCutoverRetry
      ? { ...candidateParams, clientMutationId: mintMutationId() }
      : candidateParams
    const response = await sendWorktreeCreateResilient(
      client,
      params,
      supportsIdempotentCutoverRetry
    )
    if (response.ok) {
      const result = (response as RpcSuccess).result as { worktree: { id: string } }
      return { worktreeId: result.worktree.id, name: candidateName }
    }
    lastError = response.error.message
    if (!isRetryableWorktreeCreateConflict(lastError ?? '')) {
      break
    }
  }
  return { error: lastError ?? 'Failed to create workspace' }
}

// Sends worktree.create, re-issuing whenever the request went delivery-ambiguous —
// the frame reached the wire but no response came back, so the host may already have
// built the worktree. The shared clientMutationId in `params` keeps the retry
// idempotent host-side. A definite failure (never sent, or a server error response)
// is returned to the caller untouched.
async function sendWorktreeCreateResilient(
  client: RpcClient,
  params: Record<string, unknown>,
  supportsIdempotentCutoverRetry: boolean
): Promise<RpcResponse> {
  let migrationRetry = 0
  let ambiguousRetry = 0
  const firstSentAt = Date.now()
  let replayDeadlineAt: number | null = null
  for (;;) {
    try {
      return await client.sendRequest('worktree.create', params, {
        timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
      })
    } catch (error) {
      if (!supportsIdempotentCutoverRetry) {
        throw error
      }
      if (isLogicalClientCutoverError(error)) {
        if (migrationRetry >= WORKTREE_CREATE_CUTOVER_MAX_RETRIES) {
          throw error
        }
        migrationRetry += 1
        // Why: LogicalClientCutoverError is raised only after migrateTo installs an
        // authenticated replacement, so retry immediately instead of adding UI lag.
        continue
      }
      if (!isRpcDeliveryUnknown(error) || ambiguousRetry >= WORKTREE_CREATE_AMBIGUOUS_MAX_RETRIES) {
        throw error
      }
      // Why: every transport path that reports a *drop* leaves 'connected' before the
      // rejection reaches us (rpc-client.ts:675/695/1213 set state first or reject via
      // queueMicrotask; the relay's fail() publishes synchronously). So still being
      // 'connected' here means the socket was healthy the whole time and only the
      // response went missing — the request-timeout path, which surfaces after
      // WORKTREE_CREATE_TIMEOUT_MS. That says nothing about when the host actually
      // resolved, so the dedupe record may be long gone and a replay would build a
      // second worktree instead of reconciling. Fail the create instead.
      if (client.getState() === 'connected') {
        throw error
      }
      // Computed once: a later ambiguity reads a fresher lastInboundAt from the
      // replacement session, which would push the deadline past the record it respects.
      replayDeadlineAt ??= resolveReplayDeadline(client, firstSentAt)
      const remainingWindowMs = replayDeadlineAt - Date.now()
      if (remainingWindowMs <= 0) {
        throw error
      }
      ambiguousRetry += 1
      // Why: unlike a cutover, no replacement session exists yet — resending now
      // would just hit the dead one, so wait for the transport to come back and
      // surface the original ambiguity if it does not. Clamped to the window so the
      // wait itself cannot carry the replay past the host's record.
      if (
        !(await waitForRpcClientReconnected(
          client,
          Math.min(WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS, remainingWindowMs)
        ))
      ) {
        throw error
      }
    }
  }
}

// Latest instant the host's dedupe record is still guaranteed to exist, from the earliest
// point the create could have resolved. lastInboundAt stamps a frame that really arrived,
// so it stays honest across a suspension in a way a timer budget cannot; the send is the
// fallback, and a sound floor either way, because the host cannot resolve a create it has
// not yet received.
function resolveReplayDeadline(client: RpcClient, firstSentAt: number): number {
  const lastInboundAt = client.getLastInboundAt?.() ?? null
  const anchor = lastInboundAt !== null && lastInboundAt > firstSentAt ? lastInboundAt : firstSentAt
  return anchor + WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS
}

function defaultWorktreeCreateMutationId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `worktree-create:${Date.now().toString(36)}:${randomPart}`
}
