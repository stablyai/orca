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

// Worst-case quality 72 random-noise JPEG: real Page.startScreencast sweep (2026-09-20), 143 viewports from 320–1400×480–1600, 111 fit budget.
// Measured 0.543986–0.552964 bytes/pixel; add 0.007036 (~1.3%) encoder-version margin. Re-run mobile-web-app-frame-budget-sweep.test.ts to change.
// One large-frame sample understates small viewport costs. Known unswept device outlier: 1/41 dropped at 402×593 needs ~0.5649; shell still drops overflow (C6 ruling 1).
export const WORST_CASE_JPEG_BYTES_PER_PIXEL = 0.56

/** Base64 carries three bytes in four characters, and a character is one UTF-8 byte here. */
export const BASE64_BYTES_PER_CHARACTER = 3 / 4

/** The characters base64 spends on `byteLength` bytes, padded up to a whole group as it always is. */
export function base64Characters(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3)
}

// Bound widest finite double JSON: sign, 0., five zeros and 17 significant digits (-0.0000012345678901234567); exponential form is shorter.
// Plausible widths are insufficient: underestimating metadata can push frame over cap.
const WIDEST_JSON_DOUBLE_CHARS = 25

/** `JSON.stringify(0)`, which is what the skeleton below spends per metadata field before widening. */
const NARROWEST_JSON_DOUBLE_CHARS = 1

// Derive envelope bound from real protocol shape: longest correlation id, MAX_SAFE_INTEGER counters and every metadata field widened to finite-double maximum.
// Budget cannot predict unknown loose metadata or letterboxed web frames; shell drops over-cap frames. browser-screencast-budget-at-the-shell.test.ts reconstructs bound from real encoded/serialized event.
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

// Derive area from bridge cap minus envelope: whole base64 groups→JPEG bytes→worst-case pixels, so cap changes cannot leave stale budget.
export function mobileBrowserFrameAreaBudget(): number {
  const available = BRIDGE_MAX_MESSAGE_BYTES - binaryEventEnvelopeBytes()
  // Round to whole base64 groups: 3k+1 bytes costs two more characters than 3/4 ratio predicts.
  const imageBytes = Math.floor(available / 4) * 3
  return Math.floor(imageBytes / WORST_CASE_JPEG_BYTES_PER_PIXEL)
}

// Budget only mobile density because page knows its viewport; letterboxed desktop/web frames remain unpredictable and shell drops overflow.
// Floor factor to two decimals to avoid rounding above cap; never exceed native density or fall below 1 (device pixels per CSS pixel).
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
    viewMode === 'mobile'
      ? budgetedMobileViewDeviceScaleFactor(layout)
      : MOBILE_VIEW_DEVICE_SCALE_FACTOR
  )
}
