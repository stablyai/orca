/**
 * Bounds the desktop's `<userData>/orcad-artifacts` slot cache, the way VS Code bounds its
 * server downloads: per target, keep the most recently used slots and evict the rest at
 * startup. The cache survives uninstall (it lives in userData); this is what keeps it small.
 *
 * Never evicted: a slot this process materialized (an SSH deploy may be reading it) and the
 * slot a live local orcad serve runs from, named by the profile's instance lock.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from './orcad-instance-lock'
import { materializedOrcadArtifactVersions } from '../ssh/orcad-artifact-materializer'

/** The in-use slot plus the two most recent others (the newest three when none is in use). */
export const ORCAD_ARTIFACT_CACHE_KEEP = 3

const REPAIR_SUFFIX = /\.repair-\d+$/u

export type OrcadArtifactCachePruneOptions = {
  keep?: number
  /** Slot versions to keep whatever their age. */
  inUseVersions?: ReadonlySet<string>
}

/** Removes the stale slots under `cacheRoot` and returns their paths. Best effort per entry. */
export async function pruneOrcadArtifactCache(
  cacheRoot: string,
  options: OrcadArtifactCachePruneOptions = {}
): Promise<string[]> {
  const keep = options.keep ?? ORCAD_ARTIFACT_CACHE_KEEP
  const inUse = options.inUseVersions ?? new Set<string>()
  const removed: string[] = []
  for (const target of await listNames(cacheRoot)) {
    // Only target directories hold slots; `node/` is the runtime archive cache.
    if (!Object.hasOwn(NODE_RUNTIME_ASSETS, target)) {
      continue
    }
    const targetRoot = join(cacheRoot, target)
    const slots = await Promise.all(
      // Dot entries are staging directories another process may be filling right now.
      (await listNames(targetRoot))
        .filter((name) => !name.startsWith('.'))
        .map(async (name) => ({ name, mtimeMs: await mtimeOf(join(targetRoot, name)) }))
    )
    const present = slots.filter(
      (slot): slot is { name: string; mtimeMs: number } => slot.mtimeMs !== null
    )
    const isInUse = (name: string): boolean => inUse.has(name.replace(REPAIR_SUFFIX, ''))
    // The in-use version counts toward `keep`; with none in use, the newest stands in for it.
    const othersToKeep = present.some((slot) => isInUse(slot.name)) ? keep - 1 : keep
    const others = present
      .filter((slot) => !isInUse(slot.name))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const [index, slot] of others.entries()) {
      if (index < othersToKeep) {
        continue
      }
      const path = join(targetRoot, slot.name)
      try {
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      } catch (error) {
        console.warn(`[orcad-artifacts] could not evict ${path}:`, error)
      }
    }
  }
  return removed
}

/** The desktop's startup pass over its own `<userData>/orcad-artifacts`. */
export function pruneDesktopOrcadArtifactCache(userDataPath: string): Promise<string[]> {
  const live = liveLocalOrcadServeVersion(userDataPath)
  return pruneOrcadArtifactCache(join(userDataPath, 'orcad-artifacts'), {
    inUseVersions: new Set([...materializedOrcadArtifactVersions(), ...(live ? [live] : [])])
  })
}

/** The slot version a live local orcad serve runs from, or null when none holds the profile. */
export function liveLocalOrcadServeVersion(
  userDataPath: string,
  isAlive: (pid: number) => boolean = processIsAlive
): string | null {
  const record = readOrcadInstanceLockRecord(join(userDataPath, ORCAD_LOCK_FILE_NAME))
  return record && record.role !== 'desktop' && isAlive(record.pid) ? record.version : null
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? info.mtimeMs : null
  } catch {
    return null
  }
}
