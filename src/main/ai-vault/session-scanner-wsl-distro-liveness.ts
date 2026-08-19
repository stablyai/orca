import { parseWslUncPath } from '../../shared/wsl-paths'
import { listRunningWslDistrosAsync } from '../wsl'

/**
 * The name of the stopped distro a UNC root belongs to, or null when the
 * root should be scanned normally — either it is not a WSL UNC path, the
 * distro is running, or the running-distros probe itself failed (fail open:
 * an unknown state must not hide a distro's content).
 *
 * Why: touching `\\wsl.localhost\<distro>\...` on a stopped distro either
 * pays its cold-boot latency inline, or (observed on this codebase's own
 * corpus) stalls behind the single-slot WSL transcript gate for tens of
 * seconds per root — the dominant cost in a pathologically slow scan. This
 * check costs one cached `wsl --list --running` call (never boots anything)
 * instead.
 */
export async function stoppedWslDistroForRoot(rootDir: string): Promise<string | null> {
  const info = parseWslUncPath(rootDir)
  if (!info) {
    return null
  }
  const running = await listRunningWslDistrosAsync()
  if (running === null) {
    return null
  }
  const wanted = info.distro.toLowerCase()
  return [...running].some((distro) => distro.toLowerCase() === wanted) ? null : info.distro
}
