import { readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { extractString } from '../../../../shared/text/trimmed-string'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readCodexRolloutBytes } from '../../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../../native-chat/transcript-streaming/transcript-stream-lines'

const SESSION_META_MAX_BYTES = 16 * 1024 * 1024
const CACHE_FILE = 'codex-rollout-history-bases.json'
const ROLLOUT_DATE = /^rollout-(\d{4}-\d{2}-\d{2})T/

/**
 * Which rollouts other rollouts read their history prefix from (`session_meta.history_base`).
 * A forked chat stores only its own turns and reads the rest from its parent's file.
 * `complete` is false when some folder or header couldn't be read: nothing is proven unreferenced.
 */
export type CodexRolloutHistoryReferences = {
  complete: boolean
  isReferenced(rolloutId: string): boolean
  forget(rolloutId: string): void
  save(): Promise<void>
}

/** [rollout date from its name, the rollout id its history_base names]. */
type CachedBase = [date: string | null, base: string | null]

/** The YYYY-MM-DD a rollout's name carries: Codex names it when the thread starts. */
function codexRolloutNameDate(path: string): string | null {
  return path.split(/[\\/]/).at(-1)?.match(ROLLOUT_DATE)?.[1] ?? null
}

/**
 * The first date a fork of these rollouts can carry, two days early: a rollout's name carries the
 * local date it started, and time zones move.
 */
export function earliestForkDate(paths: readonly string[]): string | null {
  let earliest: string | null = null
  for (const path of paths) {
    const date = codexRolloutNameDate(path)
    if (!date) {
      return null
    }
    earliest = earliest === null || date < earliest ? date : earliest
  }
  if (earliest === null) {
    return null
  }
  const time = Date.parse(`${earliest}T00:00:00Z`)
  return Number.isFinite(time)
    ? new Date(time - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null
}

/** Like Codex's metadata reader: lines before session_meta are skipped until a response item. */
async function readHistoryBase(path: string): Promise<string | null | undefined> {
  try {
    for await (const { line, terminated } of splitTranscriptStreamLines(
      readCodexRolloutBytes(path),
      SESSION_META_MAX_BYTES
    )) {
      if (!line.trim()) {
        continue
      }
      // Most headers name no base: skip parsing their base instructions.
      if (
        terminated &&
        line.includes('"type":"session_meta"') &&
        !line.includes('"history_base"')
      ) {
        return null
      }
      const record = parseJsonObject(line)
      if (!record) {
        // A header still being written is unknown; a broken earlier line is skipped, as in Codex.
        if (!terminated) {
          return undefined
        }
        continue
      }
      if (record.type === 'session_meta') {
        const base = asRecord(asRecord(record.payload)?.history_base)
        return extractString(base?.thread_id)?.toLowerCase() ?? null
      }
      if (record.type === 'response_item') {
        return null
      }
    }
    return null
  } catch (error) {
    // A rollout removed meanwhile references nothing; any other failure leaves it unknown.
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

function isCachedEntry(entry: unknown): entry is [string, string | null, string | null] {
  return (
    Array.isArray(entry) &&
    typeof entry[0] === 'string' &&
    (entry[1] === null || typeof entry[1] === 'string') &&
    (entry[2] === null || typeof entry[2] === 'string')
  )
}

async function readCache(path: string): Promise<Map<string, CachedBase>> {
  try {
    const bases = asRecord(JSON.parse(await readFile(path, 'utf-8')))?.bases
    return new Map(
      (Array.isArray(bases) ? bases : [])
        .filter(isCachedEntry)
        .map(([id, date, base]) => [id, [date, base]])
    )
  } catch {
    return new Map()
  }
}

async function writeCache(path: string, cache: Map<string, CachedBase>): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const bases = [...cache].map(([id, [date, base]]) => [id, date, base])
  await writeFile(tmpPath, JSON.stringify({ version: 1, bases }), 'utf-8')
  await rename(tmpPath, path)
}

/** Null when the folder is missing; throws when it can't be read. */
async function readFolder(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/** Dated folders (YYYY/MM/DD) wholly before `since` hold no rollout started on or after it. */
function isDatedFolderBefore(parts: readonly string[], since: string | null): boolean {
  if (!since || parts.length === 0 || parts.length > 3) {
    return false
  }
  if (!parts.every((part, index) => (index === 0 ? /^\d{4}$/ : /^\d{2}$/).test(part))) {
    return false
  }
  const prefix = parts.join('-')
  return prefix < since.slice(0, prefix.length)
}

/**
 * Mirrors Codex's own delete, which refuses a rollout that another rollout's history still reads.
 * A fork starts after its parent, so rollouts named before `since` are not read. Each rollout's base
 * is cached on disk by rollout id: Codex writes that header once, so it never changes.
 */
export async function scanCodexRolloutHistoryReferences(
  homes: readonly string[],
  since: string | null,
  signal?: AbortSignal
): Promise<CodexRolloutHistoryReferences> {
  const cachePath = join(getOrcaUserDataPath(), CACHE_FILE)
  const cache = await readCache(cachePath)
  let dirty = false
  let complete = true
  const seen = new Set<string>()
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()

  const visitRollout = async (path: string, rolloutId: string, date: string | null) => {
    if (seen.has(rolloutId)) {
      return
    }
    const cached = cache.get(rolloutId)
    const base = cached ? cached[1] : await readHistoryBase(path)
    if (base === undefined) {
      complete = false
      return
    }
    seen.add(rolloutId)
    if (!cached) {
      cache.set(rolloutId, [date, base])
      dirty = true
    }
    if (base === null || base === rolloutId) {
      return
    }
    baseByChild.set(rolloutId, base)
    const children = childrenByBase.get(base) ?? new Set<string>()
    children.add(rolloutId)
    childrenByBase.set(base, children)
  }

  const walk = async (folder: string, parts: string[]): Promise<void> => {
    signal?.throwIfAborted()
    for (const entry of (await readFolder(folder)) ?? []) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        if (!isDatedFolderBefore([...parts, entry.name], since)) {
          await walk(path, [...parts, entry.name])
        }
        continue
      }
      const rolloutId = codexPhysicalRolloutId(entry.name)
      const date = codexRolloutNameDate(entry.name)
      if (rolloutId && (!since || !date || date >= since)) {
        await visitRollout(path, rolloutId, date)
      }
    }
  }

  // Accounts that share history link the same folders, so each real folder is walked once.
  const walked = new Set<string>()
  try {
    for (const home of homes) {
      for (const name of ['sessions', 'archived_sessions']) {
        let folder: string
        try {
          folder = await realpath(join(home, name))
        } catch (error) {
          if (isDefinitiveAbsence(error)) {
            continue
          }
          throw error
        }
        if (!walked.has(folder)) {
          walked.add(folder)
          await walk(folder, [])
        }
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    console.warn('[workspace-cleanup] Could not read Codex rollouts to find forks:', error)
    complete = false
  }
  // Rollouts in the range just read that no home has any more.
  if (complete) {
    for (const [id, [date]] of cache) {
      if (!seen.has(id) && (!since || !date || date >= since)) {
        cache.delete(id)
        dirty = true
      }
    }
  }

  const save = async (): Promise<void> => {
    if (!dirty) {
      return
    }
    dirty = false
    await writeCache(cachePath, cache).catch((error: unknown) => {
      console.warn('[workspace-cleanup] Could not save Codex fork scan:', error)
    })
  }
  await save()
  return {
    complete,
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    forget: (rolloutId) => {
      const base = baseByChild.get(rolloutId)
      if (base) {
        childrenByBase.get(base)?.delete(rolloutId)
      }
      dirty = cache.delete(rolloutId) || dirty
    },
    save
  }
}
