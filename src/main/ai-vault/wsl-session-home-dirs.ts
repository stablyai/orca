import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

// Why: resolving a distro's `$HOME` spawns `wsl.exe -d <distro> --exec bash`,
// which boots every stopped distro (~1.3 GB of vmmemWSL). One module owns the
// probe so the Agent Session History scan, the delete/subagent allowlists, and
// the native-chat transcript resolver all honor the same opt-out.
let isEnabledFn: () => boolean = () => true

export function configureWslSessionHomeDirs(options: { isEnabled?: () => boolean }): void {
  isEnabledFn = options.isEnabled ?? (() => true)
}

export function isWslSessionScanEnabled(): boolean {
  return process.platform === 'win32' && isEnabledFn()
}

/** Each installed distro's `$HOME` as a `\\wsl.localhost` UNC path. */
async function probeWslSessionHomeDirs(): Promise<string[]> {
  if (!isWslSessionScanEnabled()) {
    return []
  }
  const homes = await Promise.all(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
}

/**
 * Uncached: feeds the scan roots and the renderer-path allowlists (delete,
 * subagent list), which must never judge against a stale distro set.
 * listWslDistrosAsync caches the distro list and getWslHomeAsync caches hits.
 */
export function listWslSessionHomeDirs(): Promise<string[]> {
  return probeWslSessionHomeDirs()
}

// Why: resolveSessionFilePath runs on a 500ms–5s poll loop. listWslDistrosAsync
// caches, but getWslHomeAsync does NOT cache failures, so a cold/stopped distro
// would re-spawn wsl.exe on every tick. Cache the composed answer here instead.
const WSL_HOME_DIRS_EMPTY_RETRY_MS = 30_000
// Why: a distro that was booting when we first probed resolves to no $HOME and
// would otherwise be excluded for the whole session. Both branches expire so it
// is retried; getWslHomeAsync caches successes, so a refresh only re-spawns
// wsl.exe for the distros that actually failed.
const WSL_HOME_DIRS_TTL_MS = 5 * 60_000
let cachedWslHomeDirs: string[] | null = null
let cachedWslHomeDirsExpiresAt = 0
let inflightWslHomeDirs: Promise<string[]> | null = null
// Why: a probe that started before the setting flipped off must not write its
// pre-flip homes back once clear() has run — the toggle would be undone for a
// full TTL. Each clear bumps the generation; a probe only publishes its own.
let cacheGeneration = 0

/** TTL-cached twin of listWslSessionHomeDirs for the transcript poll loops.
 *  `load` lets tests stand in for the probe; the cache applies either way. */
export function listWslSessionHomeDirsCached(
  load: () => Promise<string[]> = probeWslSessionHomeDirs
): Promise<string[]> {
  if (cachedWslHomeDirs && Date.now() < cachedWslHomeDirsExpiresAt) {
    return Promise.resolve(cachedWslHomeDirs)
  }
  if (inflightWslHomeDirs) {
    return inflightWslHomeDirs
  }
  const generation = cacheGeneration
  const probe = load()
    .catch(() => [] as string[])
    .then((dirs) => {
      if (generation !== cacheGeneration) {
        // Superseded by a clear: hand the caller its answer, keep the cache empty.
        return dirs
      }
      cachedWslHomeDirs = dirs
      cachedWslHomeDirsExpiresAt =
        Date.now() + (dirs.length > 0 ? WSL_HOME_DIRS_TTL_MS : WSL_HOME_DIRS_EMPTY_RETRY_MS)
      inflightWslHomeDirs = null
      return dirs
    })
  inflightWslHomeDirs = probe
  return probe
}

/** Drops the TTL cache so a settings flip takes effect on the next poll tick. */
export function clearWslSessionHomeDirsCache(): void {
  cacheGeneration += 1
  cachedWslHomeDirs = null
  cachedWslHomeDirsExpiresAt = 0
  inflightWslHomeDirs = null
}

export function resetWslSessionHomeDirsForTests(): void {
  clearWslSessionHomeDirsCache()
  isEnabledFn = () => true
}
