import { posix, win32 } from 'node:path'
import type { GlobalSettings } from '../../shared/types'
import {
  resolveHostCodexSessionSourceHome,
  resolveWslCodexSessionSourceHome
} from './codex-session-source-home'

export function resolveCodexSessionAuthorityHomes(args: {
  runtimeHomePath: string
  systemHomePath: string
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
  platform: NodeJS.Platform
  wslSystemHomes?: ReadonlyMap<string, string>
}): string[] {
  const hostSourceHome = resolveHostCodexSessionSourceHome(args.settings) ?? args.systemHomePath
  const homes = [args.runtimeHomePath, hostSourceHome]
  if (args.platform === 'win32') {
    const distros = new Set([
      ...Object.keys(args.settings.codexSessionSourceHome?.wsl ?? {}),
      ...(args.wslSystemHomes?.keys() ?? [])
    ])
    for (const distro of distros) {
      const sourceHome = resolveWslCodexSessionSourceHome(args.settings, distro)
      const hostPath = sourceHome
        ? wslLinuxPathToUnc(sourceHome, distro)
        : args.wslSystemHomes?.get(distro)
      if (hostPath) {
        homes.push(hostPath)
      }
    }
  }
  return homes.filter((home, index) => homes.indexOf(home) === index)
}

function wslLinuxPathToUnc(linuxPath: string, distro: string): string | null {
  const normalizedDistro = distro.trim()
  if (!normalizedDistro || !posix.isAbsolute(linuxPath)) {
    return null
  }
  // Why: scanners run in the Windows host process, while resume converts this
  // authority path back to Linux through parseWslUncPath.
  return win32.join('\\\\wsl.localhost', normalizedDistro, ...linuxPath.split('/').filter(Boolean))
}
