import {
  MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS,
  MobileWebSourceControlCommitPayloadSchema,
  MobileWebSourceControlCommitResultSchema,
  type MobileWebSourceControlCommitResult
} from '../../../src/shared/mobile-web/source-control-commit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { assertFreshMobileWebCommitSnapshot } from './mobile-web-source-control-commit-preflight'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebSourceControlCommit(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebSourceControlCommitResult> {
  const payload = MobileWebSourceControlCommitPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertFreshMobileWebCommitSnapshot(client, payload, hostWorkspaceId)
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const response = await client.sendRequest('git.commit', {
    worktree: `id:${hostWorkspaceId}`,
    message: payload.message.trim()
  })
  if (!response.ok || !isRecord(response.result) || typeof response.result.success !== 'boolean') {
    throw new MobileWebBrokerError('host_error')
  }
  if (!response.result.success) {
    return MobileWebSourceControlCommitResultSchema.parse({
      workspaceId: payload.workspaceId,
      previousHead: payload.expectedHead,
      status: 'failed',
      error: boundedCommitError(response.result.error)
    })
  }
  return MobileWebSourceControlCommitResultSchema.parse({
    workspaceId: payload.workspaceId,
    previousHead: payload.expectedHead,
    status: 'committed',
    head: await readCommittedHead(client, hostWorkspaceId, payload.expectedHead)
  })
}

async function readCommittedHead(
  client: RpcClient,
  hostWorkspaceId: string,
  previousHead: string
): Promise<string | null> {
  try {
    const response = await client.sendRequest('git.status', {
      worktree: `id:${hostWorkspaceId}`
    })
    if (!response.ok || !isRecord(response.result)) {
      return null
    }
    const head = response.result.head
    return typeof head === 'string' &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) &&
      head !== previousHead
      ? head
      : null
  } catch {
    // Why: commit delivery succeeded; a failed refresh must not report the write as failed.
    return null
  }
}

function boundedCommitError(value: unknown): string {
  const fallback = 'Commit failed on the paired Desktop.'
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS)
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
