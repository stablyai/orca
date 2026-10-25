import { parseWslUncPath } from '../../shared/wsl-paths'

// The bridge preserves the caller's distro even when /mnt/c makes cwd a Windows drive path.
export function getWslAccountTarget(cwd: string): { runtime: 'wsl'; wslDistro: string } | null {
  const distro =
    process.platform === 'win32'
      ? process.env.ORCA_CLI_WSL_DISTRO?.trim() || parseWslUncPath(cwd)?.distro
      : undefined
  return distro ? { runtime: 'wsl', wslDistro: distro } : null
}
