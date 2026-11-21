import { readBrowserScreencastFrameSeq } from '../../../../shared/browser/screencast/browser-screencast-protocol'
import type { ActiveBrowserScreencastSubscriber } from './browser-screencast-contracts'
import { recordScreencastSubscriberSend } from './browser-screencast-ghost-subscriber-eviction'
import {
  sendRemoteBrowserScreencastFrame,
  type ScreencastFrameSendOutcome
} from './remote-browser-screencast-frame-admission'

// Match the frame pacer's backpressure retry interval.
export const SCREENCAST_PENDING_FRAME_RETRY_MS = 50

/** Retry the newest rejected frame: an idle page may never produce another to replace it. */
export function deliverScreencastSubscriberFrame(
  subscriber: ActiveBrowserScreencastSubscriber,
  bytes: Uint8Array<ArrayBufferLike>
): void {
  // Held for credit, not refused: the viewer's ack or the stall probe sends the newest held frame.
  if (subscriber.frameCredit && !subscriber.frameCredit.credit.canSend()) {
    subscriber.pendingFrame = bytes
    return
  }
  const outcome = sendSubscriberFrame(subscriber, bytes)
  const retry = outcome === 'backlogged' || outcome === 'refused'
  subscriber.pendingFrame = retry ? bytes : null
  // Backlog proves an active socket, not a ghost; an oversize drop says nothing about the socket.
  if (outcome === 'handled' || outcome === 'refused') {
    subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, outcome === 'handled')
  }
  if (retry) {
    schedulePendingFrameRetry(subscriber)
  }
}

/** Credit opened up: send the held frame now instead of on the next produced one. */
export function flushCreditedScreencastFrame(subscriber: ActiveBrowserScreencastSubscriber): void {
  if (subscriber.pendingFrameRetry) {
    return
  }
  retryPendingFrame(subscriber)
}

export function cancelScreencastSubscriberFrameRetry(
  subscriber: ActiveBrowserScreencastSubscriber
): void {
  if (subscriber.pendingFrameRetry) {
    clearTimeout(subscriber.pendingFrameRetry)
    subscriber.pendingFrameRetry = null
  }
  subscriber.pendingFrame = null
  subscriber.frameCredit?.release()
  subscriber.frameCredit = null
}

function sendSubscriberFrame(
  subscriber: ActiveBrowserScreencastSubscriber,
  bytes: Uint8Array<ArrayBufferLike>
): ScreencastFrameSendOutcome {
  const outcome = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
  if (outcome === 'handled' && subscriber.frameCredit) {
    const seq = readBrowserScreencastFrameSeq(bytes)
    if (seq !== null) {
      subscriber.frameCredit.credit.recordSent(seq)
    }
  }
  return outcome
}

function retryPendingFrame(subscriber: ActiveBrowserScreencastSubscriber): void {
  const bytes = subscriber.pendingFrame
  if (!bytes || (subscriber.frameCredit && !subscriber.frameCredit.credit.canSend())) {
    return
  }
  const outcome = sendSubscriberFrame(subscriber, bytes)
  if (outcome === 'backlogged' || outcome === 'refused') {
    schedulePendingFrameRetry(subscriber)
    return
  }
  subscriber.pendingFrame = null
  // Count ghost refusals only on produced frames, never retries.
  if (outcome === 'handled') {
    subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, true)
  }
}

function schedulePendingFrameRetry(subscriber: ActiveBrowserScreencastSubscriber): void {
  if (subscriber.pendingFrameRetry) {
    return
  }
  subscriber.pendingFrameRetry = setTimeout(() => {
    subscriber.pendingFrameRetry = null
    retryPendingFrame(subscriber)
  }, SCREENCAST_PENDING_FRAME_RETRY_MS)
}
