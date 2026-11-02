import type { ActiveBrowserScreencastSubscriber } from './browser/browser-screencast-contracts'
import { recordScreencastSubscriberSend } from './browser-screencast-ghost-subscriber-eviction'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'

// Match the frame pacer's backpressure retry interval.
export const SCREENCAST_PENDING_FRAME_RETRY_MS = 50

/** Retry the newest rejected frame: an idle page may never produce another to replace it. */
export function deliverScreencastSubscriberFrame(
  subscriber: ActiveBrowserScreencastSubscriber,
  bytes: Uint8Array<ArrayBufferLike>
): void {
  const outcome = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
  subscriber.pendingFrame = outcome === 'handled' ? null : bytes
  // Backlog proves an active socket, not a ghost.
  if (outcome !== 'backlogged') {
    subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, outcome === 'handled')
  }
  if (outcome !== 'handled') {
    schedulePendingFrameRetry(subscriber)
  }
}

export function cancelScreencastSubscriberFrameRetry(
  subscriber: ActiveBrowserScreencastSubscriber
): void {
  if (subscriber.pendingFrameRetry) {
    clearTimeout(subscriber.pendingFrameRetry)
    subscriber.pendingFrameRetry = null
  }
  subscriber.pendingFrame = null
}

function schedulePendingFrameRetry(subscriber: ActiveBrowserScreencastSubscriber): void {
  if (subscriber.pendingFrameRetry) {
    return
  }
  subscriber.pendingFrameRetry = setTimeout(() => {
    subscriber.pendingFrameRetry = null
    const bytes = subscriber.pendingFrame
    if (!bytes) {
      return
    }
    // Count ghost refusals only on produced frames, never retries.
    if (sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes) === 'handled') {
      subscriber.pendingFrame = null
      subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, true)
    } else {
      schedulePendingFrameRetry(subscriber)
    }
  }, SCREENCAST_PENDING_FRAME_RETRY_MS)
}
