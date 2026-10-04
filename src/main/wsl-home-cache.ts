const MAX_WSL_HOME_CACHE_ENTRIES = 64
const wslHomeCache = new Map<string, string>()

// Why: WSL distro names are case-insensitive, and paths and callers spell them differently.
function cacheKey(distro: string): string {
  return distro.toLowerCase()
}

export function getCachedWslHome(distro: string): string | undefined {
  const key = cacheKey(distro)
  const home = wslHomeCache.get(key)
  if (home === undefined) {
    return undefined
  }
  wslHomeCache.delete(key)
  wslHomeCache.set(key, home)
  return home
}

export function rememberWslHome(distro: string, home: string): string {
  const key = cacheKey(distro)
  wslHomeCache.delete(key)
  wslHomeCache.set(key, home)
  while (wslHomeCache.size > MAX_WSL_HOME_CACHE_ENTRIES) {
    const oldest = wslHomeCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    wslHomeCache.delete(oldest)
  }
  return home
}

export function hasCachedWslHome(distro: string): boolean {
  return wslHomeCache.has(cacheKey(distro))
}

export function clearWslHomeCache(): void {
  wslHomeCache.clear()
}
