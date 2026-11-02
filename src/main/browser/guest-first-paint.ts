import type { WebContents } from 'electron'
import type { CapturePaintHold } from './cdp-screenshot'
import { isEmbeddedGuest, type GuestCdpSender } from './guest-direct-key-input'
import { readRecord, settleWithin } from './guest-frame-input-sessions'

const PAINTED_EXPRESSION = "performance.getEntriesByType('paint').length > 0"
const AWAIT_FIRST_PAINT_EXPRESSION = `new Promise((resolve) => {
  let frames = 0
  const tick = () => (${PAINTED_EXPRESSION} || ++frames >= 6 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
})`

// A document that paints only its background never records a paint entry, so gate it once.
const gatedDocumentByGuest = new WeakMap<WebContents, number>()

// Answers the document to gate, or null. A failed or timed-out probe means a busy page.
async function unpaintedDocument(send: GuestCdpSender): Promise<number | null> {
  const response = await settleWithin(
    send('Runtime.evaluate', {
      expression: `[${PAINTED_EXPRESSION}, performance.timeOrigin]`,
      returnByValue: true
    }),
    null
  )
  const value = readRecord(response, 'result')?.value
  return Array.isArray(value) && value[0] === false && typeof value[1] === 'number'
    ? value[1]
    : null
}

/**
 * Lets a guest document paint before agent input reaches it. Chromium drops input to a document
 * that has not painted, and one that loaded while its pane was parked never paints on its own.
 * A painted document keeps taking input once parked again, so the hold ends at the first paint.
 */
export async function waitForGuestFirstPaint(
  guest: WebContents,
  send: GuestCdpSender,
  holdPaint: CapturePaintHold
): Promise<void> {
  if (!isEmbeddedGuest(guest)) {
    return
  }
  const documentTimeOrigin = await unpaintedDocument(send)
  if (documentTimeOrigin === null || gatedDocumentByGuest.get(guest) === documentTimeOrigin) {
    return
  }
  gatedDocumentByGuest.set(guest, documentTimeOrigin)
  const release = holdPaint()
  try {
    // Input sent before the paint is presented is still dropped; blank documents never record one.
    await settleWithin(
      send('Runtime.evaluate', { expression: AWAIT_FIRST_PAINT_EXPRESSION, awaitPromise: true }),
      null
    )
  } finally {
    release()
  }
}
