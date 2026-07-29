import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  isRetryableWorktreeCreateConflict
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

export type CreateWorktreeWithNameRetryArgs = {
  client: RpcClient
  baseName: string
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
    const candidateName = getClientWorktreeCreateCandidate(baseName, attempt)
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

// Sends worktree.create, re-issuing on a connection-migration cutover only. The
// shared clientMutationId in `params` keeps the retry idempotent host-side.
async function sendWorktreeCreateResilient(
  client: RpcClient,
  params: Record<string, unknown>,
  supportsIdempotentCutoverRetry: boolean
): Promise<RpcResponse> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      return await client.sendRequest('worktree.create', params, {
        timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
      })
    } catch (error) {
      if (
        !supportsIdempotentCutoverRetry ||
        !isLogicalClientCutoverError(error) ||
        migrationRetry >= WORKTREE_CREATE_CUTOVER_MAX_RETRIES
      ) {
        throw error
      }
      // Why: LogicalClientCutoverError is raised only after migrateTo installs an
      // authenticated replacement, so retry immediately instead of adding UI lag.
    }
  }
}

function defaultWorktreeCreateMutationId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `worktree-create:${Date.now().toString(36)}:${randomPart}`
}
