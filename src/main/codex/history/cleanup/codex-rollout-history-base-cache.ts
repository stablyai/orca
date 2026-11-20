import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'

const CACHE_CHECKPOINT_MS = 30_000

/** Each rollout's settled history base, kept across sweeps in Orca's data folder. */
export type CodexRolloutHistoryBaseCache = {
  get(rolloutId: string): string | null | undefined
  set(rolloutId: string, base: string | null): Promise<void>
  delete(rolloutId: string): void
  /** Drops every rollout not in `kept`. */
  prune(kept: ReadonlySet<string>): void
  save(): Promise<void>
}

function isCachedEntry(entry: unknown): entry is [string, string | null] {
  return (
    Array.isArray(entry) &&
    typeof entry[0] === 'string' &&
    (entry[1] === null || typeof entry[1] === 'string')
  )
}

export async function loadCodexRolloutHistoryBaseCache(
  cachePath: string
): Promise<CodexRolloutHistoryBaseCache> {
  let bases: Map<string, string | null>
  try {
    const stored = asRecord(JSON.parse(await readFile(cachePath, 'utf-8')))?.bases
    bases = new Map((Array.isArray(stored) ? stored : []).filter(isCachedEntry))
  } catch {
    bases = new Map()
  }
  let dirty = false
  let savedAt = Date.now()

  const save = async (): Promise<void> => {
    if (!dirty) {
      return
    }
    dirty = false
    savedAt = Date.now()
    const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify({ version: 2, bases: [...bases] }), 'utf-8')
      await rename(tmpPath, cachePath)
    } catch (error) {
      // Saved again on the next checkpoint or at the end; no copy is left behind meanwhile.
      dirty = true
      await rm(tmpPath, { force: true }).catch(() => undefined)
      console.warn('[workspace-cleanup] Could not save the Codex fork scan:', error)
    }
  }

  return {
    get: (rolloutId) => bases.get(rolloutId),
    set: async (rolloutId, base) => {
      bases.set(rolloutId, base)
      dirty = true
      if (Date.now() - savedAt >= CACHE_CHECKPOINT_MS) {
        await save()
      }
    },
    delete: (rolloutId) => {
      dirty = bases.delete(rolloutId) || dirty
    },
    prune: (kept) => {
      for (const rolloutId of bases.keys()) {
        if (!kept.has(rolloutId)) {
          bases.delete(rolloutId)
          dirty = true
        }
      }
    },
    save
  }
}
