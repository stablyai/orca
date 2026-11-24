import { randomUUID } from 'node:crypto'
import type {
  BrowserGrabRect,
  BrowserGrabScreenshot
} from '../../../shared/browser/element-grab/browser-grab-types'
import { GRAB_BUDGET } from '../../../shared/browser/element-grab/browser-grab-types'
import { grabDocumentScope, requestGrabExecution, restoreGrabCapture } from './grab-guest-execution'
import { readbackThroughCaptureLane } from './grab-clean-page-capture'

type Snapshot = BrowserGrabRect & { viewportWidth: number }
const capturing = new WeakSet<Electron.WebContents>()

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.viewportWidth === b.viewportWidth
  )
}

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

/** Covers both the wait for a native capture already in flight on the guest and this readback. */
export const SELECTION_CAPTURE_DEADLINE_MS = 2_000

export async function captureSelectionScreenshot(
  _rect: BrowserGrabRect,
  guest: Electron.WebContents,
  selectionId: string | undefined,
  holdPaint: () => () => void
): Promise<BrowserGrabScreenshot | null> {
  if (!selectionId || capturing.has(guest) || guest.isDestroyed()) {
    return null
  }
  let releasePaint: () => void
  try {
    releasePaint = holdPaint()
  } catch {
    return null
  }
  capturing.add(guest)
  const scope = grabDocumentScope(guest)
  // The picker main knows is live now. Cancel or a new arm retires it in main synchronously, before
  // any page report it races, so the native submission checks it, not only the page's answer.
  const pickerAtStart = scope.overlayId
  const pickerStillOwned = (): boolean => scope.current && scope.overlayId === pickerAtStart
  const captureId = randomUUID()
  // Once the readback is submitted the lane helper owns the lease: held until Electron settles it.
  let paintHandedOff = false
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
    // The pick is still live, in this document, where it was when the capture was prepared.
    const pickUnchanged = async (): Promise<boolean> => {
      const checked = await requestGrabExecution(guest, '', {
        scope,
        loadedOnly: true,
        pick: { selectionId, operation: 'snapshot' }
      })
      const current = checked.ok ? readSnapshot(checked.value) : null
      return current !== null && scope.current && sameSnapshot(current, rect)
    }
    // The shared lane keeps this readback from overlapping Draw's or the paint restore's capture.
    // A readback that waited for the lane confirms the pick again first: a pick cancelled, replaced
    // or detached meanwhile must not cost a native readback another capture is waiting behind.
    paintHandedOff = true
    const image = await readbackThroughCaptureLane(
      guest,
      new AbortController().signal,
      releasePaint,
      SELECTION_CAPTURE_DEADLINE_MS,
      { canSubmit: pickerStillOwned, confirmAfterWait: pickUnchanged }
    )
    if (!image || image.isEmpty() || !pickerStillOwned() || guest.isDestroyed()) {
      return null
    }
    if (!(await pickUnchanged())) {
      return null
    }
    // Main may have retired the picker while that page answer was in transit: no bytes then.
    if (!pickerStillOwned() || guest.isDestroyed()) {
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
    restoreGrabCapture(scope, captureId)
    // A readback the deadline abandoned keeps the guest's capture lane, not this guard.
    capturing.delete(guest)
    if (!paintHandedOff) {
      releasePaint()
    }
  }
}
