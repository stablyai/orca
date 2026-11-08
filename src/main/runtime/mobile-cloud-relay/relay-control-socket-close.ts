import type WebSocket from 'ws'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'

const NORMAL_CLOSE_CODE = 1000
const REASONED_CLOSE_FLUSH_MS = 1_000

// Only auth loss sends a named close; rotation/drain/quit/sleep terminate abruptly to avoid false sign-outs.
// Bound named-close handshakes, then terminate so fencing remains hard.
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
