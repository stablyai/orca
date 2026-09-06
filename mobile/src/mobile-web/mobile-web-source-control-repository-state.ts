import {
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlUpstreamSnapshotSchema,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlUpstreamSnapshot
} from '../../../src/shared/mobile-web/source-control-sync-contract'
import { MobileWebGitRefNameSchema } from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { resolveMobileWebSourceControlBaseRef } from './mobile-web-source-control-base-ref'

export async function readMobileWebSourceControlRepositoryState(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string
): Promise<MobileWebSourceControlRepositoryState> {
  const [statusResponse, upstreamResponse, baseRef] = await Promise.all([
    client.sendRequest('git.status', { worktree: `id:${hostWorkspaceId}` }),
    client.sendRequest('git.upstreamStatus', { worktree: `id:${hostWorkspaceId}` }),
    resolveMobileWebSourceControlBaseRef(client, hostWorkspaceId)
  ])
  if (!statusResponse.ok || !upstreamResponse.ok || !isRecord(statusResponse.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebSourceControlRepositoryStateSchema.parse({
    workspaceId: pageWorkspaceId,
    head: safeHead(statusResponse.result.head),
    branch: safeBranch(statusResponse.result.branch),
    conflictOperation: safeConflictOperation(statusResponse.result.conflictOperation),
    baseRef,
    upstream: sanitizeMobileWebUpstreamSnapshot(upstreamResponse.result)
  })
}

export async function readMobileWebSourceControlStatusIdentity(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<Pick<MobileWebSourceControlRepositoryState, 'head' | 'branch' | 'conflictOperation'>> {
  const response = await client.sendRequest('git.status', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return {
    head: safeHead(response.result.head),
    branch: safeBranch(response.result.branch),
    conflictOperation: safeConflictOperation(response.result.conflictOperation)
  }
}

export async function tryReadMobileWebSourceControlRepositoryState(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string
): Promise<MobileWebSourceControlRepositoryState | null> {
  try {
    return await readMobileWebSourceControlRepositoryState(client, pageWorkspaceId, hostWorkspaceId)
  } catch {
    // Why: the Git write already completed; a failed refresh must not turn it into a false failure.
    return null
  }
}

export function sanitizeMobileWebUpstreamSnapshot(
  value: unknown
): MobileWebSourceControlUpstreamSnapshot {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const upstreamName = boundedString(value.upstreamName, 240)
  return MobileWebSourceControlUpstreamSnapshotSchema.parse({
    hasUpstream: value.hasUpstream === true,
    ...(upstreamName ? { upstreamName } : {}),
    ahead: safeNonnegativeInteger(value.ahead),
    behind: safeNonnegativeInteger(value.behind),
    hasConfiguredPushTarget: value.hasConfiguredPushTarget === true,
    behindCommitsArePatchEquivalent: value.behindCommitsArePatchEquivalent === true
  })
}

function safeHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function safeBranch(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function safeConflictOperation(value: unknown): 'merge' | 'rebase' | 'cherry-pick' | 'unknown' {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' ? value : 'unknown'
}

function safeNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
