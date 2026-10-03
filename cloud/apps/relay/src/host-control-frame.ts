import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import type WebSocket from 'ws'
import type { RawData } from 'ws'

export function waitForHostControlFrame(
  socket: WebSocket,
  timeoutMs: number,
  timeoutReason: string,
  onFrame: (raw: RawData, binary: boolean) => void
): void {
  if (socket.readyState !== socket.OPEN) return
  const cleanup = (): void => {
    clearTimeout(timer)
    socket.off('close', cleanup)
    socket.off('message', onMessage)
  }
  const onMessage = (raw: RawData, binary: boolean): void => {
    cleanup()
    onFrame(raw, binary)
  }
  const timer = setTimeout(() => {
    cleanup()
    socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, timeoutReason)
  }, timeoutMs)
  socket.once('close', cleanup)
  socket.once('message', onMessage)
}
