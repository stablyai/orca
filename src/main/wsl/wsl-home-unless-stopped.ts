import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { getCachedWslHome } from '../wsl-home-cache'
import { blockedWslDistroForPath } from './wsl-unc-access-gate'

/** The distro's home for authorization; an uncached home is only probed (wsl.exe) while it runs (E9). */
export async function wslHomeUnlessStopped(distro: string): Promise<string | null> {
  if (getCachedWslHome(distro) === undefined && (await blockedWslDistroForPath('', distro))) {
    return null
  }
  return getWslHomeAsync(distro)
}

async function homesOf(distros: readonly string[]): Promise<string[]> {
  const homes = await Promise.all(distros.map((distro) => wslHomeUnlessStopped(distro)))
  return homes.filter((home): home is string => Boolean(home))
}

/**
 * UNC homes of distros a fresh running list confirms, for background scans (E9). A failed probe
 * lists none and says so (`confirmed: false`): a stale "running" answer plus a cached home would
 * hand a stopped distro's root to the scanner.
 */
export async function readRunningWslHomeDirsUnlessStopped(): Promise<{
  homes: string[]
  confirmed: boolean
}> {
  const read = await readConfirmedRunningWslDistros()
  return read.status === 'confirmed'
    ? { homes: await homesOf(read.distros), confirmed: true }
    : { homes: [], confirmed: false }
}

export async function listRunningWslHomeDirsUnlessStopped(): Promise<string[]> {
  return (await readRunningWslHomeDirsUnlessStopped()).homes
}

/**
 * Homes for checking a path a user act names (delete, subagents, a transcript lookup): checking a
 * path against a root reads nothing, so a failed probe keeps the last-known-good list.
 */
export async function listLastKnownRunningWslHomeDirs(): Promise<string[]> {
  return homesOf(await listRunningWslDistrosAsync())
}
