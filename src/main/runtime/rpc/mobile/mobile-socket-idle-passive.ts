import type { AuthenticatedMobileSocket } from './mobile-socket-wiring'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'

/** A socket that declared it only watches (keep-awake on a WSL host); idle exit ignores it. */
export function isIdlePassiveSocket(
  socket: Pick<AuthenticatedMobileSocket, 'clientCapabilities'> | undefined
): boolean {
  return socket?.clientCapabilities.includes(IDLE_PASSIVE_CLIENT_CAPABILITY) === true
}

export function countIdleBlockingConnections<Socket>(
  connections: Iterable<Socket>,
  authenticated: (
    socket: Socket
  ) => Pick<AuthenticatedMobileSocket, 'clientCapabilities'> | undefined
): number {
  let count = 0
  for (const socket of connections) {
    if (!isIdlePassiveSocket(authenticated(socket))) {
      count += 1
    }
  }
  return count
}
