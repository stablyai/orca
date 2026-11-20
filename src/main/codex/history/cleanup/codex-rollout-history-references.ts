import { open, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { extractString } from '../../../../shared/text/trimmed-string'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readCodexRolloutBytes } from '../../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../../native-chat/transcript-streaming/transcript-stream-lines'

const SESSION_META_MAX_BYTES = 16 * 1024 * 1024
const HEAD_BYTES = 64 * 1024
const CACHE_FILE = 'codex-rollout-history-bases.json'
const CACHE_CHECKPOINT_READS = 2000
// Codex creates a rollout empty and writes its header after collecting git info.
const UNFINISHED_HEADER_GRACE_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Which rollouts other rollouts read their history prefix from (`session_meta.history_base`); a
 * forked chat stores only its own turns and reads the rest from its parent's file. One per sweep.
 */
export type CodexRolloutHistoryReferences = {
  /**
   * Brings the index up to date with these homes: every folder once in full, then only the
   * folders Codex names new rollouts in. False when anything couldn't be read, so no rollout is
   * proven unreferenced.
   */
  refresh(homes: readonly string[]): Promise<boolean>
  isReferenced(rolloutId: string): boolean
  forget(rolloutId: string): void
  save(): Promise<void>
}

/** A header's base: cacheable once session metadata (or the first response) was read. */
type HeaderBase = { base: string | null; definitive: boolean } | 'unknown'

function baseOf(record: Record<string, unknown>): string | null {
  const base = asRecord(asRecord(record.payload)?.history_base)
  return extractString(base?.thread_id)?.toLowerCase() ?? null
}

/** Like Codex's metadata reader: lines before session_meta are skipped until a response item. */
async function streamHistoryBase(path: string): Promise<HeaderBase> {
  for await (const { line, terminated } of splitTranscriptStreamLines(
    readCodexRolloutBytes(path),
    SESSION_META_MAX_BYTES
  )) {
    if (!line.trim()) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      if (!terminated) {
        return 'unknown'
      }
      continue
    }
    if (record.type === 'session_meta') {
      return { base: baseOf(record), definitive: true }
    }
    if (record.type === 'response_item') {
      return { base: null, definitive: true }
    }
  }
  return { base: null, definitive: false }
}

async function readHistoryBase(path: string): Promise<HeaderBase> {
  try {
    if (!path.endsWith('.zst')) {
      // Most headers fit the first read and name no base: no decoding or parsing for those.
      const handle = await open(path, 'r')
      const head = Buffer.allocUnsafe(HEAD_BYTES)
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0).finally(() => handle.close())
      const end = head.subarray(0, bytesRead).indexOf(10)
      const line = end > 0 ? head.subarray(0, end) : null
      if (line?.includes('"type":"session_meta"')) {
        if (!line.includes('"history_base"')) {
          return { base: null, definitive: true }
        }
        const record = parseJsonObject(line.toString('utf8'))
        if (record?.type === 'session_meta') {
          return { base: baseOf(record), definitive: true }
        }
      }
    }
    return await streamHistoryBase(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? { base: null, definitive: false } : 'unknown'
  }
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

export function createCodexRolloutHistoryReferences(
  signal?: AbortSignal
): CodexRolloutHistoryReferences {
  const cachePath = join(getOrcaUserDataPath(), CACHE_FILE)
  let cache: Map<string, string | null> | undefined
  let dirty = false
  let unsavedReads = 0
  let warned = false
  const seen = new Set<string>()
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()
  const walkedFolders = new Set<string>()
  let everyFolderWalked = true
  let pruned = false

  const save = async (): Promise<void> => {
    if (!dirty || !cache) {
      return
    }
    dirty = false
    unsavedReads = 0
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
    // Opening a link into a WSL distro can start it; a fork lives in a Codex home, not there.
    if (process.platform === 'win32' && parseWslUncPath(await realpath(path).catch(() => path))) {
      return true
    }
    const header = await readHistoryBase(path)
    if (header === 'unknown') {
      return false
    }
    if (!header.definitive) {
      const modified = await stat(path).then(
        (entry) => entry.mtimeMs,
        () => 0
      )
      // A header still being written may name a base; an old empty file never will.
      return Date.now() - modified >= UNFINISHED_HEADER_GRACE_MS
    }
    link(rolloutId, header.base)
    cache!.set(rolloutId, header.base)
    dirty = true
    if (++unsavedReads >= CACHE_CHECKPOINT_READS) {
      await save()
    }
    return true
  }

  /** False when anything under the folder couldn't be read. */
  const walk = async (folder: string, visitedFolders: Set<string>): Promise<boolean> => {
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
      if (entry.isFile() && rolloutId) {
        complete = (await visitRollout(path, rolloutId)) && complete
        continue
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue
      }
      const target = await stat(path).catch(() => null)
      if (!target) {
        continue
      }
      if (target.isFile() && rolloutId) {
        complete = (await visitRollout(path, rolloutId)) && complete
      } else if (target.isDirectory()) {
        const real = await realpath(path).catch(() => path)
        if (!visitedFolders.has(real)) {
          visitedFolders.add(real)
          complete = (await walk(path, visitedFolders)) && complete
        }
      }
    }
    return complete
  }

  const refresh = async (homes: readonly string[]): Promise<boolean> => {
    try {
      cache ??= await readCache(cachePath)
      let complete = true
      const visitedFolders = new Set<string>()
      for (const home of homes) {
        for (const name of ['sessions', 'archived_sessions']) {
          let folder: string
          try {
            folder = await realpath(join(home, name))
          } catch (error) {
            complete &&= isDefinitiveAbsence(error)
            continue
          }
          if (visitedFolders.has(folder)) {
            continue
          }
          visitedFolders.add(folder)
          if (!walkedFolders.has(folder)) {
            const walked = await walk(folder, visitedFolders)
            walkedFolders.add(folder)
            everyFolderWalked &&= walked
            complete &&= walked
          } else if (name === 'sessions') {
            for (const parts of recentDatedFolders()) {
              complete = (await walk(join(folder, ...parts), visitedFolders)) && complete
            }
          }
        }
      }
      // Once every folder was read in full, cached rollouts no home has any more drop out.
      if (complete && everyFolderWalked && !pruned) {
        pruned = true
        for (const id of cache.keys()) {
          if (!seen.has(id)) {
            cache.delete(id)
            dirty = true
          }
        }
      }
      if ((!complete || !everyFolderWalked) && !warned) {
        warned = true
        console.warn(
          '[workspace-cleanup] Some Codex rollouts could not be read; keeping forks safe'
        )
      }
      return complete && everyFolderWalked
    } catch (error) {
      await save()
      throw error
    }
  }

  return {
    refresh,
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    forget: (rolloutId) => {
      const base = baseByChild.get(rolloutId)
      if (base) {
        childrenByBase.get(base)?.delete(rolloutId)
      }
      if (cache?.delete(rolloutId)) {
        dirty = true
      }
    },
    save
  }
}
