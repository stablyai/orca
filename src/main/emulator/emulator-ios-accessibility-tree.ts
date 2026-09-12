import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import { deriveAxUrlFromStreamUrl } from './serve-sim-detached-session'
import type { EmulatorBackend } from './backends/emulator-backend'

export async function readIosAccessibilityTree(
  backend: EmulatorBackend,
  device: string,
  sessionRegistry: EmulatorSessionRegistry,
  worktreeId: string | undefined,
  getActiveForWorktree: (worktreeId?: string) => EmulatorSessionInfo | null
): Promise<unknown> {
  const udid = await backend.resolveDeviceId(device)
  // Fall back to the udid-keyed session so an explicit --device read works
  // from a worktree with no active emulator (matching tap/type reachability).
  const session =
    (worktreeId ? getActiveForWorktree(worktreeId) : null) ?? sessionRegistry.getSession(udid)
  if (worktreeId && session && session.deviceUdid !== udid) {
    throw new EmulatorError(
      'emulator_no_active',
      `iOS simulator ${udid} is not active for this worktree (active: ${session.deviceUdid}); attach the requested simulator first.`
    )
  }
  // Heal sessions registered without an axUrl (parse-time derivation only
  // covers fresh --detach output) by deriving it from the mjpeg stream URL.
  const axUrl = session?.axUrl ?? deriveAxUrlFromStreamUrl(session?.streamUrl)
  return backend.accessibilityTree!(udid, axUrl)
}
