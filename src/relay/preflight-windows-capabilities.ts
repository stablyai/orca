import { isPwshAvailableAsync } from '../main/pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'

export async function detectWindowsTerminalCapabilities(): Promise<{
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  hostPlatform: NodeJS.Platform | null
}> {
  const [wslAvailable, pwshAvailable, gitBashAvailable] = await Promise.all([
    isWslAvailableAsync().catch(() => false),
    isPwshAvailableAsync().catch(() => false),
    Promise.resolve(isGitBashAvailable()).catch(() => false)
  ])
  const wslDistros = wslAvailable ? await listWslDistrosAsync().catch(() => []) : []
  return {
    wslAvailable,
    wslDistros,
    pwshAvailable,
    gitBashAvailable,
    hostPlatform: process.platform
  }
}
