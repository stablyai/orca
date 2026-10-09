import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import { deriveAxUrlFromStreamUrl } from './serve-sim-detached-session'
import type { EmulatorBackend } from './backends/emulator-backend'

// Reads the iOS simulator's accessibility tree for an explicit --device from a
// worktree with no active emulator, healing sessions registered without an
// axUrl by deriving it from the mjpeg stream URL.
export async function readIosAccessibilityTree(
  backend: EmulatorBackend,
  device: string,
  worktreeId: string | undefined,
  registry: EmulatorSessionRegistry
): Promise<unknown> {
  const udid = await backend.resolveDeviceId(device)
  const session =
    (worktreeId ? registry.getActiveForWorktree(worktreeId) : null) ?? registry.getSession(udid)
  if (worktreeId && session && session.deviceUdid !== udid) {
    throw new EmulatorError(
      'emulator_no_active',
      `iOS simulator ${udid} is not active for this worktree (active: ${session.deviceUdid}); attach the requested simulator first.`
    )
  }
  const axUrl = session?.axUrl ?? deriveAxUrlFromStreamUrl(session?.streamUrl)
  return backend.accessibilityTree!(udid, axUrl)
}
