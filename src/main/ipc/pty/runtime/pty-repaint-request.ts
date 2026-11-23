import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** The host owning the PTY redraws its program; a host that cannot leaves queued input held.
 *  Resolves false only when a later ask could still reach it. */
export async function requestRepaintFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<boolean> {
  const { runtime } = deps
  // Why: a phone or remote desktop owns this grid, and its layout repaints the program itself.
  if (
    runtime?.getDriver(ptyId).kind === 'mobile' ||
    runtime?.isRemoteDesktopResizeDriven?.(ptyId) === true
  ) {
    return false
  }
  try {
    const provider = getProviderForPty(ptyId)
    // A host without the request (SSH, daemons before v60) never gains it, so asking again is moot.
    await provider.requestRepaint?.(ptyId)
    return true
  } catch {
    // No provider owns this PTY any more, or its host could not be reached.
    return false
  }
}
