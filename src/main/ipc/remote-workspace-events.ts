import type { DirectSshAuthority } from '../../shared/ssh-types'

type RemoteWorkspaceNotificationHandler = (
  targetId: string,
  method: string,
  params: Record<string, unknown>,
  authority: DirectSshAuthority
) => void

const handlers = new Set<RemoteWorkspaceNotificationHandler>()

export function registerRemoteWorkspaceNotificationHandler(
  handler: RemoteWorkspaceNotificationHandler
): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function notifyRemoteWorkspaceHandlers(
  targetId: string,
  method: string,
  params: Record<string, unknown>,
  authority: DirectSshAuthority
): void {
  for (const handler of handlers) {
    handler(targetId, method, params, authority)
  }
}
