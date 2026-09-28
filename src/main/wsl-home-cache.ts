const MAX_WSL_HOME_CACHE_ENTRIES = 64
const wslHomeCache = new Map<string, string>()

export function getCachedWslHome(distro: string): string | undefined {
  const home = wslHomeCache.get(distro)
  if (home === undefined) {
    return undefined
  }
  wslHomeCache.delete(distro)
  wslHomeCache.set(distro, home)
  return home
}

export function rememberWslHome(distro: string, home: string): string {
  wslHomeCache.delete(distro)
  wslHomeCache.set(distro, home)
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
  return wslHomeCache.has(distro)
}

export function clearWslHomeCache(): void {
  wslHomeCache.clear()
}
