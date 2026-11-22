import { getWslCallerDistro } from '../hosts/wsl-caller-distro'

export function getWslAccountTarget(cwd: string): { runtime: 'wsl'; wslDistro: string } | null {
  const distro = getWslCallerDistro(cwd)
  return distro ? { runtime: 'wsl', wslDistro: distro } : null
}
