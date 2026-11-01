import type { NativeImage, WebContents } from 'electron'
import type { PluginViewDrawnPanel } from '../../../shared/plugins/view/plugin-view-protocol'

// Why 5 MiB: base64 of it still fits the 8 MiB frame remote Orca servers accept.
export const PLUGIN_SHOT_MAX_PNG_BYTES = 5 * 1024 * 1024
const GUEST_SETTLE_TIMEOUT_MS = 1_500

/** Runs `body` with the window's renderer (and the guest) painting even while hidden. The
 *  window itself is never shown: background throttling only gates the renderer's frames. */
export async function withPaintingWhileHidden<T>(
  targets: readonly WebContents[],
  body: () => Promise<T>
): Promise<T> {
  const restore = targets
    .filter((contents) => !contents.isDestroyed() && contents.getBackgroundThrottling())
    .map((contents) => {
      contents.setBackgroundThrottling(false)
      return contents
    })
  try {
    return await body()
  } finally {
    for (const contents of restore) {
      if (!contents.isDestroyed()) {
        contents.setBackgroundThrottling(true)
      }
    }
  }
}

/** Two frames inside an html panel's guest, so a theme or layout change it just got is painted. */
export async function settlePluginFrameGuest(guest: WebContents | undefined): Promise<void> {
  if (!guest || guest.isDestroyed()) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, GUEST_SETTLE_TIMEOUT_MS)
  })
  const frames = guest
    .executeJavaScript(
      'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))'
    )
    .then(
      () => undefined,
      () => undefined
    )
  await Promise.race([frames, timeout])
  clearTimeout(timer)
}

/** The renderer measures in CSS pixels; capturePage takes window points, which zoom scales. */
export function pluginPanelCaptureRect(
  rect: PluginViewDrawnPanel['rect'],
  zoomFactor: number
): { x: number; y: number; width: number; height: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const x = Math.max(0, Math.round(rect.x * zoom))
  const y = Math.max(0, Math.round(rect.y * zoom))
  return { x, y, width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) }
}

type CaptureRect = { x: number; y: number; width: number; height: number }

/** Creates an image from raw pixels; `nativeImage.createFromBitmap` in the app. */
export type BitmapImageFactory = (
  bitmap: Buffer,
  size: { width: number; height: number }
) => NativeImage

/** One image pixel per window point: HiDPI captures come back 2x. */
function atSize(image: NativeImage, width: number, height: number): NativeImage {
  const size = image.getSize()
  return size.width === width && size.height === height
    ? image
    : image.resize({ width, height, quality: 'best' })
}

/** Copies `top` (same pixel format) onto `base` at (x, y), clipped to `base`. */
export function compositeBitmap(
  base: { bitmap: Buffer; width: number; height: number },
  top: { bitmap: Buffer; width: number; height: number },
  x: number,
  y: number
): Buffer {
  const out = Buffer.from(base.bitmap)
  const left = Math.max(0, x)
  const right = Math.min(base.width, x + top.width)
  for (let row = Math.max(0, y); row < Math.min(base.height, y + top.height); row += 1) {
    if (right <= left) {
      break
    }
    const from = ((row - y) * top.width + (left - x)) * 4
    top.bitmap.copy(out, (row * base.width + left) * 4, from, from + (right - left) * 4)
  }
  return out
}

// Why retry as well: a fallback in case even a stayHidden capture returns a bare background (Linux CI).
// Why stayHidden: Electron's documented way to keep a hidden window rendering for the capture.
const HIDDEN_CAPTURE = { stayHidden: true }
const BLANK_RETRY_WAIT_MS = 150
const BLANK_RETRIES = 8

/** Two colors or fewer: a background and maybe a border, i.e. nothing of the panel drawn yet. */
export function looksBlank(bitmap: Buffer): boolean {
  const seen = new Set<number>()
  for (let offset = 0; offset + 3 < bitmap.byteLength; offset += 4) {
    seen.add(bitmap.readUInt32LE(offset))
    if (seen.size > 2) {
      return false
    }
  }
  return true
}

async function captureUntilDrawn(
  contents: WebContents,
  target: CaptureRect,
  wait: (ms: number) => Promise<void>
): Promise<NativeImage> {
  const grab = async (): Promise<NativeImage> => {
    const shot = await contents.capturePage(target, HIDDEN_CAPTURE)
    return shot.isEmpty() ? shot : atSize(shot, target.width, target.height)
  }
  let image = await grab()
  for (let tries = 0; tries < BLANK_RETRIES && !image.isEmpty(); tries += 1) {
    if (!looksBlank(image.toBitmap())) {
      break
    }
    await wait(BLANK_RETRY_WAIT_MS)
    image = await grab()
  }
  return image
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The PNG of exactly that rect, at one image pixel per window point. Why the guest separately:
 * on Linux the window capture leaves a `<webview>` guest blank, so an html panel's guest is
 * captured from its own webContents and drawn over the window capture at its rect.
 */
export async function capturePluginPanelPng(
  contents: WebContents,
  rect: PluginViewDrawnPanel['rect'],
  guest?: { contents: WebContents; rect: CaptureRect; fromBitmap: BitmapImageFactory },
  wait: (ms: number) => Promise<void> = sleep
): Promise<{ png: Buffer; width: number; height: number }> {
  const zoom = contents.getZoomFactor()
  const target = pluginPanelCaptureRect(rect, zoom)
  if (target.width < 1 || target.height < 1) {
    throw new Error('The panel has no area to capture; is the right sidebar collapsed?')
  }
  // An html panel's guest is drawn over this capture below, so only a bare host is retried.
  let image: NativeImage = guest
    ? await contents.capturePage(target, HIDDEN_CAPTURE)
    : await captureUntilDrawn(contents, target, wait)
  if (image.isEmpty()) {
    throw new Error('Orca drew nothing to capture; try again once its window has loaded.')
  }
  image = atSize(image, target.width, target.height)
  if (guest && !guest.contents.isDestroyed()) {
    const area = pluginPanelCaptureRect(guest.rect, zoom)
    const shot = area.width > 0 && area.height > 0 ? await guest.contents.capturePage() : null
    if (shot && !shot.isEmpty()) {
      const top = atSize(shot, area.width, area.height)
      const bitmap = compositeBitmap(
        { bitmap: image.toBitmap(), ...target },
        { bitmap: top.toBitmap(), width: area.width, height: area.height },
        area.x - target.x,
        area.y - target.y
      )
      image = guest.fromBitmap(bitmap, { width: target.width, height: target.height })
    }
  }
  const png = image.toPNG()
  if (png.byteLength > PLUGIN_SHOT_MAX_PNG_BYTES) {
    throw new Error(
      `The capture is ${Math.ceil(png.byteLength / 1024 / 1024)} MiB, over the ${PLUGIN_SHOT_MAX_PNG_BYTES / 1024 / 1024} MiB limit; pass a smaller --width.`
    )
  }
  return { png, width: target.width, height: target.height }
}
