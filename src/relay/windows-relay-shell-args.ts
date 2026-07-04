import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../main/powershell-osc133-bootstrap'

const WINDOWS_POWERSHELL_SAFE_MODE_ENV = 'ORCA_WINDOWS_POWERSHELL_SAFE_MODE'

function shouldLaunchWindowsPowerShellWithoutProfile(env: Record<string, string>): boolean {
  return env[WINDOWS_POWERSHELL_SAFE_MODE_ENV] === '1'
}

export function getWindowsRelayShellArgs(
  shellName: string,
  env: Record<string, string>,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  if (
    shellName === 'powershell.exe' ||
    shellName === 'powershell' ||
    shellName === 'pwsh.exe' ||
    shellName === 'pwsh'
  ) {
    return [
      '-NoLogo',
      ...(shouldLaunchWindowsPowerShellWithoutProfile(env) ? ['-NoProfile'] : []),
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(getPowerShellOsc133Bootstrap())
    ]
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return []
  }
  if (shellName === 'wsl.exe' || shellName === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}
