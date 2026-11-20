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
  const rect = value as Snapshot
  return [rect.x, rect.y, rect.width, rect.height, rect.viewportWidth].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.viewportWidth > 0
    ? rect
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
    const x = Math.max(0, Math.round(rect.x * scale))
    const y = Math.max(0, Math.round(rect.y * scale))
    const width = Math.min(bitmap.width - x, Math.round(rect.width * scale))
    const height = Math.min(bitmap.height - y, Math.round(rect.height * scale))
    if (width <= 0 || height <= 0) {
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
