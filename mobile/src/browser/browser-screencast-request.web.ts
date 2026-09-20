import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { METADATA_KEYS } from '../transport/browser-screencast-protocol'
import {
  assembleMobileBrowserScreencastRequest,
  MOBILE_VIEW_DEVICE_SCALE_FACTOR,
  type BrowserStreamLayout,
  type MobileBrowserScreencastRequest,
  type MobileBrowserViewMode
} from './browser-screencast-request-parameters'

export { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request-parameters'
export type {
  BrowserStreamLayout,
  MobileBrowserScreencastRequest,
  MobileBrowserViewMode
} from './browser-screencast-request-parameters'

/**
 * The bytes one pixel of this pane's JPEG costs at its worst.
 *
 * Uniform random noise at quality 72, which is the image JPEG compresses least and the ceiling
 * every real page sits under; photographic content measures near a tenth of it.
 *
 * Swept 2026-09-20 over 143 viewports — widths 320 to 1400 and heights 480 to 1600 — each encoded
 * by Chromium at the scale `budgetedMobileViewDeviceScaleFactor` picks for it. Across the 111 the
 * budget fits, the measured cost ranged from 0.54470 to 0.55351 bytes per pixel. This is that
 * maximum plus a margin of 0.00649, about 1.2%, for the encoder version it was not swept on.
 *
 * It was 0.545 before that sweep, taken from one 2400x2160 frame. A single large frame is the
 * cheapest per pixel in the whole range, so the number it gave was under 90 of those 143 viewports
 * and the budget it produced posted a frame over the cap on a phone. A worst case measured at one
 * point is not a worst case; `mobile-web-app-frame-budget-sweep.test.ts` is what holds this one to
 * the whole range, and re-running it is how this number is changed.
 */
export const WORST_CASE_JPEG_BYTES_PER_PIXEL = 0.56

/** Base64 carries three bytes in four characters, and a character is one UTF-8 byte here. */
export const BASE64_BYTES_PER_CHARACTER = 3 / 4

/** The characters base64 spends on `byteLength` bytes, padded up to a whole group as it always is. */
export function base64Characters(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3)
}

/**
 * The widest `JSON.stringify` of a finite double.
 *
 * Sign, `0.`, the five zeros fixed notation writes just above 1e-6, and seventeen significant
 * digits: `-0.0000012345678901234567`. Exponential form is one character shorter, because ToString
 * only leaves fixed notation below 1e-6, so this covers both.
 *
 * It has to be an upper bound rather than a plausible width. The budget's entire margin is what
 * this over-estimates by, so a metadata field wider than assumed is a frame over the cap.
 */
const WIDEST_JSON_DOUBLE_CHARS = 25

/** `JSON.stringify(0)`, which is what the skeleton below spends per metadata field before widening. */
const NARROWEST_JSON_DOUBLE_CHARS = 1

/**
 * An upper bound on what the frame's envelope costs, derived rather than typed, so the budget
 * cannot drift from the shape the shell actually sends.
 *
 * Everything but the image at its widest: a full-length correlation id, both sequence counters at
 * the largest integer they can hold, and every named metadata field present and as wide as a double
 * can print. The field list comes from the protocol module rather than a copy of it, so a tenth
 * field cannot be added to frames without being paid for here.
 *
 * Two things it does not cover, both of them C6 ruling 1's to drop rather than this budget's to
 * predict: the metadata object is a loose one, so a shell may send keys this list has never heard
 * of, and web view mode's frame is a letterboxed desktop viewport the page cannot size.
 *
 * `browser-screencast-budget-at-the-shell.test.ts` is what makes this evidence rather than an
 * assumption checked against a copy of itself: it reconstructs this number, to the byte, from a
 * frame the real encoder produced and the real host serialized.
 */
export function binaryEventEnvelopeBytes(): number {
  const skeleton = JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    id: 'a'.repeat(22),
    seq: Number.MAX_SAFE_INTEGER,
    binary: {
      b64: '',
      format: 'jpeg',
      frameSeq: Number.MAX_SAFE_INTEGER,
      metadata: Object.fromEntries(METADATA_KEYS.map((key) => [key, 0]))
    }
  }).length
  return skeleton + METADATA_KEYS.length * (WIDEST_JSON_DOUBLE_CHARS - NARROWEST_JSON_DOUBLE_CHARS)
}

/**
 * The frame area one bridge message can carry, in device pixels.
 *
 * The cap, less what the envelope costs, is the base64 the image may occupy; three quarters of that
 * is the JPEG; divided by the worst case a pixel costs, it is an area. Computed from the cap rather
 * than written down beside it, because a cap that moves and a budget that does not is a pane that
 * goes dark on a page it could have streamed.
 */
export function mobileBrowserFrameAreaBudget(): number {
  const available = BRIDGE_MAX_MESSAGE_BYTES - binaryEventEnvelopeBytes()
  // Whole base64 groups, not three quarters of the room: an image of 3k+1 bytes costs two
  // characters more than the ratio says, which at a margin this tight is a dropped frame.
  const imageBytes = Math.floor(available / 4) * 3
  return Math.floor(imageBytes / WORST_CASE_JPEG_BYTES_PER_PIXEL)
}

/**
 * The device scale factor the mobile view may ask for and stay inside one message.
 *
 * Mobile view is the one mode where the page knows the frame exactly: it names the viewport, so the
 * frame is that viewport times this factor squared. Web mode is a desktop viewport letterboxed into
 * `maxWidth`/`maxHeight`, which the page cannot predict, so it is left alone and C6 ruling 1's
 * drop-the-over-cap-frame rule is its only protection.
 *
 * Floored to two decimals so rounding cannot push the area back over the budget, and never above
 * what native asks for: this bounds density, it does not raise it. Never below 1 either — past that
 * the page would be asking for fewer device pixels than it has CSS pixels, which is a blurry frame
 * rather than a working one, and a frame that still does not fit is ruling 1's to drop.
 */
export function budgetedMobileViewDeviceScaleFactor(layout: BrowserStreamLayout | null): number {
  if (!layout || layout.width <= 0 || layout.height <= 0) {
    return MOBILE_VIEW_DEVICE_SCALE_FACTOR
  }
  const viewportArea = Math.round(layout.width) * Math.round(layout.height)
  const budgeted = Math.sqrt(mobileBrowserFrameAreaBudget() / viewportArea)
  return Math.max(1, Math.min(MOBILE_VIEW_DEVICE_SCALE_FACTOR, Math.floor(budgeted * 100) / 100))
}

/** Web sibling: the same request, with the mobile view's density held inside the frame cap. */
export function buildMobileBrowserScreencastRequest(
  layout: BrowserStreamLayout | null,
  pixelRatio: number,
  viewMode: MobileBrowserViewMode = 'web'
): MobileBrowserScreencastRequest | null {
  return assembleMobileBrowserScreencastRequest(
    layout,
    pixelRatio,
    viewMode,
    budgetedMobileViewDeviceScaleFactor(layout)
  )
}
