import { noteWslDistroMayHaveStopped } from '../../../wsl/discovery/wsl-background-distro-gate'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'

/** Recovery's wsl.exe spawns and UNC reads start a stopped distro (E9); host homes are never blocked. */
export async function isBackfillDistroBlocked(codexHomePath: string): Promise<boolean> {
  return (await blockedWslDistroForPath(codexHomePath)) !== null
}

/** A recovery child died on its own, maybe to `wsl --shutdown`: later gate reads must not trust an older lease. */
export function noteBackfillChildDied(codexHomePath: string): void {
  const distro = wslDistroForPath(codexHomePath)
  if (distro) {
    noteWslDistroMayHaveStopped(distro)
  }
}
