import { getLinuxDisplayServer } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

type PlatformInfo = ReturnType<PreloadApi['platform']['get']>

// Process-lifetime values are cached for frequent renderer reads.
let platformInfo: PlatformInfo | undefined

function resolvePlatformInfo(): PlatformInfo {
  return Object.freeze({
    platform: process.platform,
    // The sandbox cannot require node:os; use Electron's process API.
    osRelease:
      (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ?? '',
    arch: process.arch,
    shell: process.env.SHELL?.trim() || process.env.ComSpec?.trim() || '',
    displayServer: getLinuxDisplayServer()
  })
}

export const platformApi = {
  get: () => (platformInfo ??= resolvePlatformInfo())
} satisfies PreloadApi['platform']
