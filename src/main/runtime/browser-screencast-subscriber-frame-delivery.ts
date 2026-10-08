import type { ActiveBrowserScreencastSubscriber } from './runtime-browser-commands-browser-command-target-params'
import { recordScreencastSubscriberSend } from './browser-screencast-ghost-subscriber-eviction'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'

// Why 50: the frame pacer's own backpressure retry interval.
export const SCREENCAST_PENDING_FRAME_RETRY_MS = 50

/**
 * Sends one frame to one viewer. A frame its socket did not take is kept as the viewer's newest
 * pending frame and retried until taken: an idle page produces no next frame, so without the retry
 * a viewer behind a briefly full socket keeps a stale picture until the page changes.
 */
export function deliverScreencastSubscriberFrame(
  subscriber: ActiveBrowserScreencastSubscriber,
  bytes: Uint8Array<ArrayBufferLike>
): void {
  const outcome = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
  subscriber.pendingFrame = outcome === 'handled' ? null : bytes
  // Why: a backlogged socket is alive and busy, so only a refusal is evidence of a ghost viewer.
  if (outcome !== 'backlogged') {
    subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, outcome === 'handled')
  }
  if (outcome !== 'handled') {
    schedulePendingFrameRetry(subscriber)
  }
}

/** Paths that remove a viewer that may have received frames call this, so no retry outlives it. */
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
    // Why a refused retry is not recorded: ghost eviction must advance only on produced frames.
    if (sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes) === 'handled') {
      subscriber.pendingFrame = null
      subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, true)
    } else {
      schedulePendingFrameRetry(subscriber)
    }
  }, SCREENCAST_PENDING_FRAME_RETRY_MS)
}
