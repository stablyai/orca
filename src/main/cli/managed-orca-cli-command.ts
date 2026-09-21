import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'

export function resolveManagedOrcaCliCommand(options: {
  isPackaged: boolean
  userDataPath: string
  resourcesPath?: string | null
  platform?: NodeJS.Platform
}): string | null {
  const platform = options.platform ?? process.platform
  const candidate = options.isPackaged
    ? options.resourcesPath
      ? getBundledLauncherPath(platform, options.resourcesPath)
      : null
    : join(options.userDataPath, 'cli', 'bin', platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev')
  if (!candidate) {
    return null
  }
  try {
    if (!statSync(candidate).isFile()) {
      return null
    }
    accessSync(candidate, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return candidate
  } catch {
    return null
  }
}
