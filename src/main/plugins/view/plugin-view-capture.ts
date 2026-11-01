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

/** The PNG of exactly that rect, at one image pixel per window point. */
export async function capturePluginPanelPng(
  contents: WebContents,
  rect: PluginViewDrawnPanel['rect']
): Promise<{ png: Buffer; width: number; height: number }> {
  const target = pluginPanelCaptureRect(rect, contents.getZoomFactor())
  if (target.width < 1 || target.height < 1) {
    throw new Error('The panel has no area to capture; is the right sidebar collapsed?')
  }
  let image: NativeImage = await contents.capturePage(target)
  if (image.isEmpty()) {
    throw new Error('Orca drew nothing to capture; try again once its window has loaded.')
  }
  const size = image.getSize()
  if (size.width !== target.width || size.height !== target.height) {
    // Why scale down: HiDPI captures are 2x, and agents read the panel at its on-screen size.
    image = image.resize({ width: target.width, height: target.height, quality: 'best' })
  }
  const png = image.toPNG()
  if (png.byteLength > PLUGIN_SHOT_MAX_PNG_BYTES) {
    throw new Error(
      `The capture is ${Math.ceil(png.byteLength / 1024 / 1024)} MiB, over the ${PLUGIN_SHOT_MAX_PNG_BYTES / 1024 / 1024} MiB limit; pass a smaller --width.`
    )
  }
  return { png, width: target.width, height: target.height }
}
