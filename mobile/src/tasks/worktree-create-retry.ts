import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  agentLaunchRun,
  agentLaunchReplayRun,
  worktreeCreateRun
} from './mobile-workspace-create-operations'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../src/shared/new-workspace/worktree-create-retry-policy'
import {
  agentLaunchCreateParams,
  isAgentLaunchReplayUnsupportedRefusal,
  isAgentLaunchUnsupportedRefusal,
  readAgentLaunchCreateOutcome,
  type WorktreeCreateAgentLaunch
} from './agent-launch-request'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import { WORKTREE_CREATE_TIMEOUT_MS } from './workspace-create-timeout'
import type { WorkspaceCreateParams } from './workspace-create-params'
import type {
  WorktreeCreateIdempotencyProbe,
  WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'
import {
  sendReplayingAmbiguousDelivery,
  type AmbiguousDeliveryReplay
} from './replay-on-ambiguous-delivery'

// Branches and remote PRs outlive worktrees and escape local preflight dedupe; retry host collision errors with numeric suffixes.
export type WorktreeCreateResult =
  | { worktreeId: string; name: string; warning?: string }
  | { error: string }

export type CreateWorktreeWithNameRetryArgs = {
  client: RpcClient
  baseName: string
  nameWasGenerated?: boolean
  buildParams: (name: string) => WorkspaceCreateParams
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunch?: WorktreeCreateAgentLaunch
  maxAttempts?: number
  mintMutationId?: () => string
  mintLaunchOperationId?: () => string
}

export async function createWorktreeWithNameRetry(
  args: CreateWorktreeWithNameRetryArgs
): Promise<WorktreeCreateResult> {
  const { client, baseName, buildParams } = args
  // Wait for status before create or slow networks could silently disable safe replay.
  const worktreeCreateIdempotency = await args.worktreeCreateIdempotency
  // Fix the launch route before creating so collision retries cannot change methods.
  let launch = await resolveAgentLaunchRoute(args.agentLaunch)
  const maxAttempts = args.maxAttempts ?? CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS
  const mintMutationId = args.mintMutationId ?? defaultWorktreeCreateMutationId
  const mintLaunchOperationId = args.mintLaunchOperationId ?? structuredSessionOperationId
  let lastError: string | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateName = args.nameWasGenerated
      ? getGeneratedWorktreeCreateRetryCandidate(baseName, attempt)
      : getClientWorktreeCreateCandidate(baseName, attempt)
    const candidateParams = buildParams(candidateName)
    // Only advertised idempotency permits replay; use one key per candidate and a new key for each collision suffix.
    const params = worktreeCreateIdempotency
      ? { ...candidateParams, clientMutationId: mintMutationId() }
      : candidateParams
    const launchOperationId = launch?.replay ? mintLaunchOperationId() : null
    const sent = await sendWorktreeCreateResilient(
      client,
      launch?.agent ?? null,
      launchOperationId,
      params,
      worktreeCreateIdempotency
    )
    let response = sent.response
    if (
      !response.ok &&
      !sent.replayed &&
      launch &&
      (launchOperationId
        ? isAgentLaunchReplayUnsupportedRefusal(response.error)
        : isAgentLaunchUnsupportedRefusal(response.error))
    ) {
      // Method refusal can mean the client advertisement lagged the probe; downgrade permanently for this create.
      launch = null
      response = (
        await sendWorktreeCreateResilient(client, null, null, params, worktreeCreateIdempotency)
      ).response
    }
    // Ledger refusal may follow creation; never retry unnamed. Inspect raw refusal messages for legacy collision handling.
    if (response.ok) {
      const created = readCreateResult(response, launch)
      if (created) {
        return {
          worktreeId: created.worktreeId,
          name: created.displayName?.trim() ? created.displayName : candidateName,
          ...(created.warning ? { warning: created.warning } : {})
        }
      }
      lastError = 'Failed to create workspace'
      break
    }
    lastError = response.error.message
    if (launch?.replay || !isRetryableWorktreeCreateConflict(lastError ?? '')) {
      break
    }
  }
  return { error: lastError ?? 'Failed to create workspace' }
}

async function resolveAgentLaunchRoute(
  launch: WorktreeCreateAgentLaunch | undefined
): Promise<{ agent: TuiAgent; replay: boolean } | null> {
  if (!launch) {
    return null
  }
  const support = await launch.supported
  return support ? { agent: launch.agent, replay: support.replay } : null
}

// Launch lacks display name; use the candidate until the host resolves it, preserving warnings from either route.
function readCreateResult(
  response: RpcResponse,
  launch: { replay: boolean } | null
): { worktreeId: string; displayName?: string; warning?: string } | null {
  if (launch) {
    const operation = launch.replay ? agentLaunchReplayRun : agentLaunchRun
    return readAgentLaunchCreateOutcome(operation.interpret(response))
  }
  const created = worktreeCreateRun.interpret(response)
  const worktreeId = created.worktree.id
  if (!worktreeId) {
    return null
  }
  const displayName = created.worktree.displayName
  // A successful create may still fail PTY startup; retain its warning to explain an empty session.
  const warning = typeof created?.warning === 'string' ? created.warning.trim() : ''
  return {
    worktreeId,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(warning ? { warning } : {})
  }
}

// Resend unchanged mutation/operation ids only after ambiguous delivery; a new id would create again.
// Legacy launch cache expires after 60s; only advertised launchOperationId provides durable ledger replay.
function sendWorktreeCreateResilient(
  client: RpcClient,
  launchAgent: TuiAgent | null,
  launchOperationId: string | null,
  params: WorkspaceCreateParams,
  worktreeCreateIdempotency: WorktreeCreateIdempotencySupport | false
): Promise<{ response: RpcResponse; replayed: boolean }> {
  // Only the selected method's receipt can authorize replay after an ambiguous delivery.
  const replay: AmbiguousDeliveryReplay | null = launchAgent
    ? launchOperationId
      ? { kind: 'durable' }
      : null
    : worktreeCreateIdempotency
      ? { kind: 'window', support: worktreeCreateIdempotency }
      : null
  return sendReplayingAmbiguousDelivery(
    client,
    () =>
      launchAgent
        ? launchOperationId
          ? agentLaunchReplayRun.request(
              client,
              {
                ...agentLaunchCreateParams(launchAgent, params),
                operationId: launchOperationId
              },
              { timeoutMs: WORKTREE_CREATE_TIMEOUT_MS }
            )
          : agentLaunchRun.request(
              client,
              agentLaunchCreateParams(launchAgent, params, launchOperationId),
              { timeoutMs: WORKTREE_CREATE_TIMEOUT_MS }
            )
        : worktreeCreateRun.request(client, params, {
            timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
          }),
    replay
  )
}

function defaultWorktreeCreateMutationId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `worktree-create:${Date.now().toString(36)}:${randomPart}`
}
