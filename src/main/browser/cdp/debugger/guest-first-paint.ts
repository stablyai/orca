import type { WebContents } from 'electron'
import type { CapturePaintHold } from './guest-paint-hold'
import { isEmbeddedGuest } from '../input/guest-direct-key-input'
import {
  readRecord,
  settleWithin,
  type GuestSessionCdpSender
} from '../input/guest-frame-input-sessions'

const PAINTED_EXPRESSION = "performance.getEntriesByType('paint').length > 0"
const AWAIT_FIRST_PAINT_EXPRESSION = `new Promise((resolve) => {
  let frames = 0
  const tick = () => (${PAINTED_EXPRESSION} || ++frames >= 6 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
})`

// A document that paints only its background never records a paint entry, so gate it once.
const gatedDocumentByGuest = new WeakMap<WebContents, number>()
// Cache already-painted guests until their next main-frame navigation to avoid a CDP probe per input.
const paintedGuests = new WeakSet<WebContents>()
const navigationGenerationByGuest = new WeakMap<WebContents, number>()

function ensureNavigationGeneration(guest: WebContents): number {
  const existing = navigationGenerationByGuest.get(guest)
  if (existing !== undefined) {
    return existing
  }
  navigationGenerationByGuest.set(guest, 0)
  guest.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      navigationGenerationByGuest.set(guest, (navigationGenerationByGuest.get(guest) ?? 0) + 1)
      paintedGuests.delete(guest)
    }
  })
  return 0
}

function markGuestPainted(guest: WebContents, expectedGeneration: number): void {
  // Ignore stale probe/wait resolutions if a new main-frame navigation started while awaiting.
  if (navigationGenerationByGuest.get(guest) === expectedGeneration) {
    paintedGuests.add(guest)
  }
}

// Answers the document to gate, or null. A failed or timed-out probe means a busy page.
async function unpaintedDocument(
  send: GuestSessionCdpSender
): Promise<
  { status: 'painted' } | { status: 'unpainted'; timeOrigin: number } | { status: 'unknown' }
> {
  const response = await settleWithin(
    send('Runtime.evaluate', {
      expression: `[${PAINTED_EXPRESSION}, performance.timeOrigin]`,
      returnByValue: true
    }),
    null
  )
  const value = readRecord(response, 'result')?.value
  if (!Array.isArray(value)) {
    return { status: 'unknown' }
  }
  if (value[0] === true) {
    return { status: 'painted' }
  }
  return value[0] === false && typeof value[1] === 'number'
    ? { status: 'unpainted', timeOrigin: value[1] }
    : { status: 'unknown' }
}

/**
 * Lets a guest document paint before agent input reaches it. Chromium drops input to a document
 * that has not painted, and one that loaded while its pane was parked never paints on its own.
 * A painted document keeps taking input once parked again, so the hold ends at the first paint.
 */
export async function waitForGuestFirstPaint(
  guest: WebContents,
  send: GuestSessionCdpSender,
  holdPaint: CapturePaintHold
): Promise<void> {
  if (!isEmbeddedGuest(guest) || paintedGuests.has(guest)) {
    return
  }
  const startGeneration = ensureNavigationGeneration(guest)
  const probe = await unpaintedDocument(send)
  if (probe.status === 'painted') {
    markGuestPainted(guest, startGeneration)
    return
  }
  if (probe.status === 'unknown' || gatedDocumentByGuest.get(guest) === probe.timeOrigin) {
    return
  }
  gatedDocumentByGuest.set(guest, probe.timeOrigin)
  const release = holdPaint()
  try {
    // Input sent before the paint is presented is still dropped; blank documents never record one.
    const settled = await settleWithin(
      send('Runtime.evaluate', { expression: AWAIT_FIRST_PAINT_EXPRESSION, awaitPromise: true }),
      null
    )
    if (settled !== null) {
      markGuestPainted(guest, startGeneration)
    }
  } finally {
    release()
  }
}
