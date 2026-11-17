import { TERMINAL_VIEWPORT_MIN_ROWS } from '../../../../shared/terminal/viewport/terminal-viewport'
import { ptySizes } from '../delivery/visibility-state'
import { pendingRepaintGrids } from '../delivery/pending-repaint-grids'
import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const REPAINT_RESTORE_MS = 250

/** One row smaller, then back to the size recorded by then: a same-size resize sends no SIGWINCH.
 *  The recorded size is left alone and an attach meanwhile commits the real grid, so readers and a
 *  resize landing meanwhile keep it. */
export function requestRepaintFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean {
  const size = ptySizes.get(ptyId)
  const { runtime } = deps
  if (
    !size ||
    pendingRepaintGrids.has(ptyId) ||
    // Why: a phone or remote desktop owns this grid, and its layout repaints the program itself.
    runtime?.getDriver(ptyId).kind === 'mobile' ||
    runtime?.isRemoteDesktopResizeDriven?.(ptyId) === true
  ) {
    return false
  }
  const nudgeRows = size.rows > TERMINAL_VIEWPORT_MIN_ROWS ? size.rows - 1 : size.rows + 1
  try {
    getProviderForPty(ptyId).resize(ptyId, size.cols, nudgeRows)
  } catch {
    return false
  }
  pendingRepaintGrids.set(ptyId, size)
  setTimeout(() => {
    pendingRepaintGrids.delete(ptyId)
    const latest = ptySizes.get(ptyId)
    if (!latest) {
      return
    }
    try {
      getProviderForPty(ptyId).resize(ptyId, latest.cols, latest.rows)
    } catch {
      // The PTY exited during the nudge.
    }
  }, REPAINT_RESTORE_MS).unref?.()
  return true
}
