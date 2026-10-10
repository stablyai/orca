import type WebSocket from 'ws'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'

const NORMAL_CLOSE_CODE = 1000
const REASONED_CLOSE_FLUSH_MS = 1_000

// hostCloseReason: only auth loss names itself. Every other control close
// (rotation, drain, quit, sleep) stays an abrupt terminate, so the cell learns
// nothing and can never read a restart as a sign-out. A named close has to
// reach the cell as a real close frame, but the fence must still be hard —
// bound the handshake and then terminate.
export function closeRelayControlSocket(
  socket: WebSocket | null,
  hostCloseReason?: RelayHostCloseReason
): void {
  if (!socket) {
    return
  }
  if (hostCloseReason && socket.readyState === socket.OPEN) {
    socket.close(NORMAL_CLOSE_CODE, hostCloseReason)
    const timer = setTimeout(() => socket.terminate(), REASONED_CLOSE_FLUSH_MS)
    timer.unref?.()
    return
  }
  socket.terminate()
}
