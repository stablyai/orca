import { parseWslUncPath } from '../shared/wsl-paths'
import { listRunningWslDistrosAsync } from './wsl'

export function filterPathsToWslDistros(
  paths: readonly string[],
  distros: readonly string[]
): string[] {
  const allowed = new Set(distros.map((distro) => distro.toLowerCase()))
  return paths.filter((candidate) => {
    const parsed = parseWslUncPath(candidate)
    return !parsed || allowed.has(parsed.distro.toLowerCase())
  })
}

/** Keep host paths and WSL paths whose distro is running now. */
export async function filterPathsToRunningWslDistrosAsync(
  paths: readonly string[]
): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [...paths]
  }
  return filterPathsToWslDistros(paths, await listRunningWslDistrosAsync())
}
