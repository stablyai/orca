import { parseWslUncPath } from '../../shared/wsl-paths'

// Why: `orca-ide` in a distro re-enters Windows via the PowerShell bridge, so only
// the bridged cwd's UNC form (or a forwarded WSL_DISTRO_NAME) still names the distro;
// without it the account lands in the host lane and never shows under WSL (#17089).
// A non-Windows CLI talks to a runtime with no WSL lane, so it never attributes one.
export function getWslAccountTarget(cwd: string): { runtime: 'wsl'; wslDistro: string } | null {
  const distro =
    process.platform === 'win32'
      ? process.env.WSL_DISTRO_NAME?.trim() || parseWslUncPath(cwd)?.distro
      : undefined
  return distro ? { runtime: 'wsl', wslDistro: distro } : null
}
