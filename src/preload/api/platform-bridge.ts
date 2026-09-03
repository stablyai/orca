import { getLinuxDisplayServer } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

type PlatformInfo = ReturnType<PreloadApi['platform']['get']>

// Why: the renderer reads this on its render cadence, and every field below is fixed
// for the process lifetime, so resolve once and hand back the same frozen payload.
let platformInfo: PlatformInfo | undefined

function resolvePlatformInfo(): PlatformInfo {
  return Object.freeze({
    platform: process.platform,
    // Why: sandboxed preload cannot require node:os; Electron exposes the OS
    // version on process.getSystemVersion when available.
    osRelease:
      (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ?? '',
    arch: process.arch,
    // Why: these identify the default shell without probing user config files.
    // process.env is available in the sandboxed preload; node:os is not.
    shell: process.env.SHELL?.trim() || process.env.ComSpec?.trim() || '',
    displayServer: getLinuxDisplayServer()
  })
}

export const platformApi = {
  // Why: resolved lazily so preload startup keeps paying nothing for it.
  get: () => (platformInfo ??= resolvePlatformInfo())
} satisfies PreloadApi['platform']
