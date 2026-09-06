import { MOBILE_WEB_WORKSPACE_LIST_LIMIT } from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebResumeRoute } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const MOBILE_WEB_NAVIGATION_HOST_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
const MOBILE_WEB_NAVIGATION_HOST_ID_MAX_LENGTH = 512

export async function resolveMobileWebHostNavigationRoute(
  hostWorkspaceId: string,
  client: RpcClient,
  authority: MobileWebWorkspaceAuthority
): Promise<MobileWebResumeRoute> {
  if (
    hostWorkspaceId.length === 0 ||
    hostWorkspaceId.length > MOBILE_WEB_NAVIGATION_HOST_ID_MAX_LENGTH
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
  const response = await client.sendRequest('worktree.ps', {
    limit: MOBILE_WEB_WORKSPACE_LIST_LIMIT + 1
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  const result = response.result
  if (
    mobileWebEncodedByteLength(result) > MOBILE_WEB_NAVIGATION_HOST_SNAPSHOT_MAX_BYTES ||
    !isRecord(result) ||
    !Array.isArray(result.worktrees)
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  if (
    result.truncated === true ||
    result.worktrees.length > MOBILE_WEB_WORKSPACE_LIST_LIMIT ||
    (typeof result.totalCount === 'number' && result.totalCount > MOBILE_WEB_WORKSPACE_LIST_LIMIT)
  ) {
    throw new MobileWebBrokerError('too_large')
  }

  const matches = result.worktrees.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.worktreeId === hostWorkspaceId
  )
  if (matches.length === 0) {
    return { kind: 'workspaceList' }
  }
  if (matches.length !== 1) {
    throw new MobileWebBrokerError('unavailable')
  }

  const match = matches[0]
  const hostRepoId = boundedRequiredText(match.repoId, 512)
  if (!hostRepoId) {
    throw new MobileWebBrokerError('unavailable')
  }
  const pageWorkspaceId = authority.registerWorkspace(hostWorkspaceId, hostRepoId)
  return {
    kind: 'session',
    workspaceId: pageWorkspaceId,
    workspaceName: boundedRequiredText(match.displayName, 240) ?? 'Workspace'
  }
}

function boundedRequiredText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
