import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_CACHED_ICONS = 500

let cache: Map<string, string> | null = null

export function loadCache(file: string): Map<string, string> {
  if (cache) {
    return cache
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    cache = new Map(
      parsed && typeof parsed === 'object'
        ? Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        : []
    )
  } catch {
    cache = new Map()
  }
  return cache
}

export function remember(file: string, icons: ReadonlyMap<string, string>): void {
  const cached = loadCache(file)
  for (const [name, svg] of icons) {
    cached.delete(name)
    cached.set(name, svg)
  }
  while (cached.size > MAX_CACHED_ICONS) {
    const oldest = cached.keys().next().value
    if (oldest === undefined) {
      break
    }
    cached.delete(oldest)
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(cached)))
  } catch {
    // The in-memory copy still serves this session.
  }
}

/** Drops every cached icon so the next render regenerates with the current recipe. */
export function clearWorktreeIconCache(cacheFile: string): void {
  cache = new Map()
  try {
    rmSync(cacheFile, { force: true })
  } catch {
    // An unreadable file is ignored on load; the empty in-memory cache already wins.
  }
}
