import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'
import { getCachedWslHome } from '../wsl-home-cache'
import { blockedWslDistroForPath } from './wsl-unc-access-gate'

/** The distro's home for authorization; an uncached home is only probed (wsl.exe) while it runs (E9). */
export async function wslHomeUnlessStopped(distro: string): Promise<string | null> {
  if (getCachedWslHome(distro) === undefined && (await blockedWslDistroForPath('', distro))) {
    return null
  }
  return getWslHomeAsync(distro)
}

/** UNC homes of running distros, never probing one that stopped since the list (E9). */
export async function listRunningWslHomeDirsUnlessStopped(): Promise<string[]> {
  const homes = await Promise.all(
    (await listRunningWslDistrosAsync()).map((distro) => wslHomeUnlessStopped(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
}
