import { getLinuxDisplayServer } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

export const platformApi = {
  get: () => ({
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
} satisfies PreloadApi['platform']
