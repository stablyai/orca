import { readdir, readFile, readlink, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readHistoryBase } from './codex-rollout-history-base-header'

const CACHE_FILE = 'codex-rollout-history-bases.json'
const CACHE_CHECKPOINT_MS = 30_000
// Codex creates a rollout empty and writes its header after collecting git info.
const UNFINISHED_HEADER_GRACE_MS = 10 * 60 * 1000
// Coarse filesystems stamp a folder no finer than this; a listing that close to a change repeats.
const FOLDER_STAMP_SLACK_MS = 2000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Which rollouts other rollouts read their history prefix from (`session_meta.history_base`); a
 * forked chat stores only its own turns and reads the rest from its parent's file. One per sweep.
 */
export type CodexRolloutHistoryReferences = {
  /** Reads every folder of these homes not read yet. False: something couldn't be read. */
  prepare(homes: readonly string[]): Promise<boolean>
  /**
   * `prepare`, then re-lists the folders a new or newly archived rollout lands in, when they
   * changed. False when anything couldn't be read, so no rollout is proven unreferenced.
   */
  refresh(homes: readonly string[]): Promise<boolean>
  isReferenced(rolloutId: string): boolean
  /** Drops a deleted rollout; returns the parent it was the last fork of, if any. */
  forget(rolloutId: string): string | null
  save(): Promise<void>
}

function isCachedEntry(entry: unknown): entry is [string, string | null] {
  return (
    Array.isArray(entry) &&
    typeof entry[0] === 'string' &&
    (entry[1] === null || typeof entry[1] === 'string')
  )
}

async function readCache(path: string): Promise<Map<string, string | null>> {
  try {
    const bases = asRecord(JSON.parse(await readFile(path, 'utf-8')))?.bases
    return new Map((Array.isArray(bases) ? bases : []).filter(isCachedEntry))
  } catch {
    return new Map()
  }
}

/** The dated session folders Codex can be naming new rollouts in now, in local time. */
function recentDatedFolders(): string[][] {
  const now = Date.now()
  return [-3, -2, -1, 0, 1].map((offset) => {
    const day = new Date(now + offset * DAY_MS)
    return [
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    ]
  })
}

/** Null when absent; undefined when it can't be told. */
async function statUnlessAbsent(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** Whether a link points into a WSL distro, told from its text alone: touching it can start one. */
async function linksIntoWsl(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const target = await readlink(path).catch(() => null)
  return target !== null && parseWslUncPath(resolve(dirname(path), target)) !== null
}

export function createCodexRolloutHistoryReferences(
  signal?: AbortSignal
): CodexRolloutHistoryReferences {
  const cachePath = join(getOrcaUserDataPath(), CACHE_FILE)
  let cache: Map<string, string | null> | undefined
  let dirty = false
  let savedAt = Date.now()
  let warned = false
  const seen = new Set<string>()
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()
  // Real sessions/archived_sessions folders read in full, and every folder's stamp when listed.
  const walkedRoots = new Set<string>()
  const folderStamps = new Map<string, number>()
  let everyRootWalked = true
  let pruned = false

  const save = async (): Promise<void> => {
    if (!dirty || !cache) {
      return
    }
    dirty = false
    savedAt = Date.now()
    const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify({ version: 2, bases: [...cache] }), 'utf-8')
      await rename(tmpPath, cachePath)
    } catch (error) {
      console.warn('[workspace-cleanup] Could not save the Codex fork scan:', error)
    }
  }

  const link = (rolloutId: string, base: string | null): void => {
    seen.add(rolloutId)
    if (base === null || base === rolloutId) {
      return
    }
    baseByChild.set(rolloutId, base)
    const children = childrenByBase.get(base) ?? new Set<string>()
    children.add(rolloutId)
    childrenByBase.set(base, children)
  }

  /** False when this rollout's header can't be settled yet. */
  const visitRollout = async (path: string, rolloutId: string): Promise<boolean> => {
    if (seen.has(rolloutId)) {
      return true
    }
    const cached = cache!.get(rolloutId)
    if (cached !== undefined) {
      link(rolloutId, cached)
      return true
    }
    const header = await readHistoryBase(path)
    if (header === 'unreadable') {
      return false
    }
    if (!header.settled) {
      const modified = (await statUnlessAbsent(path))?.mtimeMs ?? 0
      // A header still being written may name a base; an old empty or broken one never will.
      return Date.now() - modified >= UNFINISHED_HEADER_GRACE_MS
    }
    link(rolloutId, header.base)
    cache!.set(rolloutId, header.base)
    dirty = true
    if (Date.now() - savedAt >= CACHE_CHECKPOINT_MS) {
      await save()
    }
    return true
  }

  /** False when anything under the folder couldn't be read. `recursive: false` lists one level. */
  const walk = async (folder: string, visited: Set<string>, recursive = true): Promise<boolean> => {
    let entries: Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      return isDefinitiveAbsence(error)
    }
    let complete = true
    for (const entry of entries) {
      signal?.throwIfAborted()
      const path = join(folder, entry.name)
      const rolloutId = codexPhysicalRolloutId(entry.name)
      if (entry.isFile()) {
        complete = (!rolloutId || (await visitRollout(path, rolloutId))) && complete
        continue
      }
      if (entry.isDirectory()) {
        if (recursive) {
          complete = (await walk(path, visited)) && complete
        }
        continue
      }
      if (!entry.isSymbolicLink() || (await linksIntoWsl(path))) {
        continue
      }
      const target = await statUnlessAbsent(path)
      if (target === undefined) {
        complete = false
      } else if (target?.isFile() && rolloutId) {
        complete = (await visitRollout(path, rolloutId)) && complete
      } else if (target?.isDirectory() && recursive) {
        const real = await realpath(path).catch(() => null)
        if (real === null) {
          complete = false
        } else if (!visited.has(real)) {
          visited.add(real)
          complete = (await walk(path, visited)) && complete
        }
      }
    }
    return complete
  }

  /** Lists a folder again only when its entries changed since the last listing. */
  const relist = async (folder: string, visited: Set<string>, startedAt: number) => {
    const entry = await statUnlessAbsent(folder)
    if (entry === undefined) {
      return false
    }
    if (entry === null) {
      return true
    }
    const stamp = folderStamps.get(folder)
    if (stamp === entry.mtimeMs && startedAt - stamp > FOLDER_STAMP_SLACK_MS) {
      return true
    }
    const listed = await walk(folder, visited, false)
    if (listed) {
      folderStamps.set(folder, entry.mtimeMs)
    }
    return listed
  }

  const update = async (homes: readonly string[], recent: boolean): Promise<boolean> => {
    try {
      cache ??= await readCache(cachePath)
      const startedAt = Date.now()
      let complete = true
      const visited = new Set<string>()
      for (const home of homes) {
        for (const name of ['sessions', 'archived_sessions']) {
          let root: string
          try {
            root = await realpath(join(home, name))
          } catch (error) {
            complete &&= isDefinitiveAbsence(error)
            continue
          }
          if (visited.has(root)) {
            continue
          }
          visited.add(root)
          if (!walkedRoots.has(root)) {
            const walked = await walk(root, visited)
            walkedRoots.add(root)
            everyRootWalked &&= walked
            complete &&= walked
          } else if (recent) {
            // New rollouts land in today's dated folders; archiving moves them to the flat folder.
            const folders =
              name === 'sessions'
                ? recentDatedFolders().map((parts) => join(root, ...parts))
                : [root]
            for (const folder of folders) {
              complete = (await relist(folder, visited, startedAt)) && complete
            }
          }
        }
      }
      // Once every folder was read in full, cached rollouts no home has any more drop out.
      if (complete && everyRootWalked && !pruned) {
        pruned = true
        for (const id of cache.keys()) {
          if (!seen.has(id)) {
            cache.delete(id)
            dirty = true
          }
        }
      }
      if ((!complete || !everyRootWalked) && !warned) {
        warned = true
        console.warn('[workspace-cleanup] Some Codex rollouts could not be read; keeping forks')
      }
      return complete && everyRootWalked
    } catch (error) {
      await save()
      throw error
    }
  }

  return {
    prepare: (homes) => update(homes, false),
    refresh: (homes) => update(homes, true),
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    forget: (rolloutId) => {
      if (cache?.delete(rolloutId)) {
        dirty = true
      }
      const base = baseByChild.get(rolloutId)
      if (!base) {
        return null
      }
      baseByChild.delete(rolloutId)
      const children = childrenByBase.get(base)
      children?.delete(rolloutId)
      return children?.size === 0 ? base : null
    },
    save
  }
}
