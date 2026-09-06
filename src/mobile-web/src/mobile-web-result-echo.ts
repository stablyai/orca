import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

/** A shell that answers one workspace's request with another workspace's payload is a swap the
 * page must not accept. Six request clients each carried their own copy of this check. */
export function requireEchoedWorkspaceId<TResult extends { workspaceId: string }>(
  workspaceId: string,
  result: TResult
): TResult {
  if (result.workspaceId !== workspaceId) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return result
}
