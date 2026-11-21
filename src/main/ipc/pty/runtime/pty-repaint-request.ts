import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { RuntimeRepaintResult } from '../../../runtime/terminal/lifecycle/runtime-pty-controller-contract'

/** The host owning the PTY redraws its program; a host that cannot says so. */
export async function requestRepaintFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<RuntimeRepaintResult> {
  const { runtime } = deps
  // Why: a phone or remote desktop owns this grid, and its layout repaints the program itself.
  if (
    runtime?.getDriver(ptyId).kind === 'mobile' ||
    runtime?.isRemoteDesktopResizeDriven?.(ptyId) === true
  ) {
    return 'not-sent'
  }
  try {
    return (await getProviderForPty(ptyId).requestRepaint?.(ptyId)) ?? 'unavailable'
  } catch {
    // No provider owns this PTY any more, or the request failed: nobody was asked, as before.
    return 'not-sent'
  }
}
