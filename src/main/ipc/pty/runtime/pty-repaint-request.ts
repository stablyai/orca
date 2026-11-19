import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** The host owning the PTY redraws its program; a host that cannot leaves queued input held. */
export function requestRepaintFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): void {
  const { runtime } = deps
  // Why: a phone or remote desktop owns this grid, and its layout repaints the program itself.
  if (
    runtime?.getDriver(ptyId).kind === 'mobile' ||
    runtime?.isRemoteDesktopResizeDriven?.(ptyId) === true
  ) {
    return
  }
  try {
    void getProviderForPty(ptyId)
      .requestRepaint?.(ptyId)
      ?.catch(() => {})
  } catch {
    // No provider owns this PTY any more.
  }
}
