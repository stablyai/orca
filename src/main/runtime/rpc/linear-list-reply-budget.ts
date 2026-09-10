import { stringifyJsonWithinByteLimit } from '../../../shared/node-bounded-json-stringify'
import type { RpcRequest, RpcResponse } from './core'
import { errorResponse } from './errors'
import { decodeDeliveryPageRecovery } from '../../linear/mcp-issue-list-recovery'

export function isLinearPageRequest(request: Pick<RpcRequest, 'method' | 'params'>): boolean {
  if (request.method === 'linear.mcpListIssues') {
    return true
  }
  return (
    request.method === 'linear.listIssues' &&
    !!request.params &&
    typeof request.params === 'object' &&
    [
      'team',
      'cycle',
      'label',
      'query',
      'state',
      'cursor',
      'orderBy',
      'project',
      'release',
      'assignee',
      'delegate',
      'parentId',
      'priority',
      'createdAt',
      'updatedAt',
      'includeArchived',
      'pageRecovery'
    ].some((key) => key in (request.params as object))
  )
}

export function boundLinearListReply(request: RpcRequest, response: RpcResponse): RpcResponse {
  if (!isLinearPageRequest(request)) {
    return response
  }
  try {
    if (Buffer.byteLength(request.id) > 128) {
      throw new Error('correlation capacity')
    }
    stringifyJsonWithinByteLimit(response._meta, 16 * 1024, 2)
    if (!response.ok && Buffer.byteLength(response.error.message) > 512) {
      throw new Error('error capacity')
    }
    const params = request.params as { workspaceId?: string; pageRecovery?: unknown } | undefined
    const maxBytes = response.ok
      ? 1024 * 1024
      : params?.workspaceId === 'all' && params.pageRecovery
        ? 128 * 1024
        : 8192
    stringifyJsonWithinByteLimit(response, maxBytes - 1, 2)
    stringifyJsonWithinByteLimit(response, maxBytes)
    return response
  } catch {
    return linearListDeliveryFailure(request)
  }
}

export function linearListDeliveryFailure(request: RpcRequest): RpcResponse {
  const params = request.params as
    | { workspaceId?: unknown; cursor?: unknown; pageRecovery?: unknown }
    | undefined
  const id =
    typeof request.id === 'string' && Buffer.byteLength(request.id) <= 128 ? request.id : 'unknown'
  const workspaceId =
    typeof params?.workspaceId === 'string' && Buffer.byteLength(params.workspaceId) <= 2048
      ? params.workspaceId
      : undefined
  const cursor =
    typeof params?.cursor === 'string' && Buffer.byteLength(params.cursor) <= 4096
      ? params.cursor
      : undefined
  const recovery = {
    retryPosition: { ...(workspaceId ? { workspaceId } : {}), ...(cursor ? { cursor } : {}) },
    restartConcreteWorkspaces: workspaceId === 'all' || !workspaceId,
    detailsComplete: false
  }
  const pageRecovery = decodeDeliveryPageRecovery(params?.pageRecovery)
  const failure = errorResponse(
    id,
    { runtimeId: 'unknown' },
    'linear_list_metadata_capacity',
    'Linear reply could not be delivered; retry the input position or restart concrete workspaces and reconcile by issue ID.',
    { ...recovery, ...(workspaceId === 'all' && pageRecovery ? { pageRecovery } : {}) }
  )
  try {
    stringifyJsonWithinByteLimit(failure, pageRecovery ? 128 * 1024 - 1 : 8191, 2)
    return failure
  } catch {
    return errorResponse(
      id,
      { runtimeId: 'unknown' },
      'linear_list_metadata_capacity',
      'Linear reply could not be delivered; restart concrete workspaces and reconcile by issue ID.',
      { restartConcreteWorkspaces: true, detailsComplete: false }
    )
  }
}

export function rejectOversizedLinearListRequest(request: RpcRequest): RpcResponse | undefined {
  if (!isLinearPageRequest(request)) {
    return undefined
  }
  try {
    if (typeof request.id !== 'string' || Buffer.byteLength(request.id) > 128) {
      throw new Error('correlation capacity')
    }
    stringifyJsonWithinByteLimit(request.params, 64 * 1024)
    return undefined
  } catch {
    return linearListDeliveryFailure(request)
  }
}
