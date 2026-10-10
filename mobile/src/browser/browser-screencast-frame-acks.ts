// Why ack: the host then keeps at most this many frames unacknowledged, so a slow link carries a
// frame or two instead of seconds of them, and terminal input sharing the link is not stuck behind.
export const BROWSER_SCREENCAST_ACK_WINDOW = 2

/** Acks each received frame, but only on a stream whose host echoed `frameAck` on `ready`. */
export function createBrowserScreencastFrameAcks(
  sendAck: (subscriptionId: string, seq: number) => void
) {
  let subscriptionId: string | null = null
  return {
    onEvent(event: unknown): void {
      if (isRecord(event) && event.type === 'ready') {
        subscriptionId =
          isRecord(event.frameAck) && typeof event.subscriptionId === 'string'
            ? event.subscriptionId
            : null
      }
    },
    onFrame(seq: number): void {
      if (subscriptionId) {
        sendAck(subscriptionId, seq)
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
