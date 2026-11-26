import { lstatSync, readdirSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Exclude linked history directories to avoid reading them twice. */
export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function listClaudeProfileHomes(dataRoot: string): string[] {
  const root = join(dataRoot, 'claude-profiles')
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return []
  }
  return ids.map((id) => join(root, id, 'home')).filter(isDirectory)
}

export async function listClaudeProfileHomesAsync(dataRoot: string): Promise<string[]> {
  const root = join(dataRoot, 'claude-profiles')
  const ids = await readdir(root).catch(() => [])
  const homes = await Promise.all(
    ids.map(async (id) => {
      const home = join(root, id, 'home')
      const info = await lstat(home).catch(() => null)
      return info?.isDirectory() ? home : null
    })
  )
  return homes.filter((home) => home !== null)
}
