import { lstatSync, readdirSync, type Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CLAUDE_PROFILE_MARKER_FILE as PROFILE_MARKER } from './claude-profile-paths'

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** Exclude linked history directories to avoid reading them twice. */
export function isDirectory(path: string): boolean {
  return lstatOrNull(path)?.isDirectory() ?? false
}

function listHomes(dataRoot: string): string[] {
  const root = join(dataRoot, 'claude-profiles')
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return []
  }
  return ids.map((id) => join(root, id, 'home')).filter(isDirectory)
}

/** Every account home Orca set up; a removed account's kept history is not one. */
export function listClaudeProfileHomes(dataRoot: string): string[] {
  return listHomes(dataRoot).filter(
    (home) => lstatOrNull(join(dirname(home), PROFILE_MARKER)) !== null
  )
}

/** Every folder holding account history, including what removed accounts kept. */
export function listClaudeProfileHistoryHomes(dataRoot: string): string[] {
  return listHomes(dataRoot)
}

/** Async `listClaudeProfileHomes`. */
export async function listClaudeProfileHomesAsync(dataRoot: string): Promise<string[]> {
  const root = join(dataRoot, 'claude-profiles')
  const ids = await readdir(root).catch(() => [])
  const homes = await Promise.all(
    ids.map(async (id) => {
      const home = join(root, id, 'home')
      const [info, marker] = await Promise.all([
        lstat(home).catch(() => null),
        lstat(join(root, id, PROFILE_MARKER)).catch(() => null)
      ])
      return info?.isDirectory() && marker ? home : null
    })
  )
  return homes.filter((home) => home !== null)
}

/** False for a removed account's kept folder, which Orca no longer configures. */
export async function isConfigurableClaudeHome(dataRoot: string, dir: string): Promise<boolean> {
  const root = join(dataRoot, 'claude-profiles')
  const path = relative(root, resolve(dir))
  const [id, leaf, ...rest] = path.split(sep)
  if (!path || path.startsWith('..') || isAbsolute(path) || leaf !== 'home' || rest.length > 0) {
    return true
  }
  return (await lstat(join(root, id, PROFILE_MARKER)).catch(() => null)) !== null
}
