import type { Socket } from 'node:net'
import { encodeNdjson } from '../../../../shared/main-process-ndjson-framer'

export function writeDaemonControlNotification(
  socket: Socket,
  id: string,
  type: string,
  payload: unknown
): boolean {
  const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }
  try {
    socket.write(encodeNdjson(msg))
    return true
  } catch {
    // Notifications are best-effort; an oversized payload must not tear down the caller.
    return false
  }
}
