import { randomUUID } from 'node:crypto'
import type {
  BrowserGrabRect,
  BrowserGrabScreenshot
} from '../../../shared/browser/element-grab/browser-grab-types'
import { GRAB_BUDGET } from '../../../shared/browser/element-grab/browser-grab-types'
import { grabDocumentScope, requestGrabExecution, restoreGrabCapture } from './grab-guest-execution'

type Snapshot = BrowserGrabRect & { viewportWidth: number }
const capturing = new WeakSet<Electron.WebContents>()

function readSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  if (
    !('x' in value) ||
    !('y' in value) ||
    !('width' in value) ||
    !('height' in value) ||
    !('viewportWidth' in value)
  ) {
    return null
  }
  const { x, y, width, height, viewportWidth } = value
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  return finite(x) &&
    finite(y) &&
    finite(width) &&
    finite(height) &&
    finite(viewportWidth) &&
    width > 0 &&
    height > 0 &&
    viewportWidth > 0
    ? { x, y, width, height, viewportWidth }
    : null
}

export async function captureSelectionScreenshot(
  _rect: BrowserGrabRect,
  guest: Electron.WebContents,
  selectionId?: string
): Promise<BrowserGrabScreenshot | null> {
  if (!selectionId || capturing.has(guest) || guest.isDestroyed()) {
    return null
  }
  capturing.add(guest)
  const scope = grabDocumentScope(guest)
  const captureId = randomUUID()
  let physical: Promise<unknown> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const prepared = await requestGrabExecution(guest, '', {
      scope,
      loadedOnly: true,
      pick: { selectionId, operation: 'prepareCapture', captureId }
    })
    const rect = prepared.ok ? readSnapshot(prepared.value) : null
    if (!rect || !scope.current || guest.isDestroyed()) {
      return null
    }
    const capture = guest.capturePage().then(
      (image) => image,
      () => null
    )
    physical = capture
    const image = await Promise.race([
      capture,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2_000)
      })
    ])
    clearTimeout(timer)
    if (!image || image.isEmpty() || !scope.current || guest.isDestroyed()) {
      return null
    }
    const checked = await requestGrabExecution(guest, '', {
      scope,
      loadedOnly: true,
      pick: { selectionId, operation: 'snapshot' }
    })
    const current = checked.ok ? readSnapshot(checked.value) : null
    if (
      !current ||
      !scope.current ||
      current.x !== rect.x ||
      current.y !== rect.y ||
      current.width !== rect.width ||
      current.height !== rect.height ||
      current.viewportWidth !== rect.viewportWidth
    ) {
      return null
    }
    const bitmap = image.getSize()
    const scale = bitmap.width / rect.viewportWidth
    if (!Number.isFinite(scale) || scale <= 0) {
      return null
    }
    const x = Math.max(0, Math.round(rect.x * scale))
    const y = Math.max(0, Math.round(rect.y * scale))
    const width = Math.min(bitmap.width - x, Math.round(rect.width * scale))
    const height = Math.min(bitmap.height - y, Math.round(rect.height * scale))
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return null
    }
    const png = image.crop({ x, y, width, height }).toPNG()
    if (png.byteLength > GRAB_BUDGET.screenshotMaxBytes) {
      return null
    }
    return {
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: Math.round(width / scale),
      height: Math.round(height / scale)
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    restoreGrabCapture(scope, captureId)
    // A timed-out native capture still occupies its one physical slot until Electron settles it.
    if (physical) {
      void physical.finally(() => capturing.delete(guest))
    } else {
      capturing.delete(guest)
    }
  }
}
