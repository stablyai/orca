import { noteWslDistroMayHaveStopped } from '../../../wsl/discovery/wsl-background-distro-gate'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'

export type BackfillDistroState = 'running' | 'stopped' | 'unverifiable'

/** Recovery's wsl.exe spawns and UNC reads start a stopped distro (E9); host homes always run. */
export async function readBackfillDistroState(codexHomePath: string): Promise<BackfillDistroState> {
  // The gate already re-reads an unverifiable answer once past the failure backoff.
  return (await blockedWslDistroForPath(codexHomePath))?.state ?? 'running'
}

export async function isBackfillDistroBlocked(codexHomePath: string): Promise<boolean> {
  return (await readBackfillDistroState(codexHomePath)) !== 'running'
}

/** A recovery child died on its own, maybe to `wsl --shutdown`: later gate reads must not trust an older lease. */
export function noteBackfillChildDied(codexHomePath: string): void {
  const distro = wslDistroForPath(codexHomePath)
  if (distro) {
    noteWslDistroMayHaveStopped(distro)
  }
}
