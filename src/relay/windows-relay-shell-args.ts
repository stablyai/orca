import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../main/powershell-osc133-bootstrap'

const WINDOWS_POWERSHELL_SAFE_MODE_ENV = 'ORCA_WINDOWS_POWERSHELL_SAFE_MODE'

// Why: safe mode must stay per launch so one relay session cannot force
// profile-free PowerShell startup for unrelated sessions in the same process.
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
      // Why: EncodedCommand only primes OSC133; startup commands are sent after
      // shell readiness so profiles can load before user commands run.
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
