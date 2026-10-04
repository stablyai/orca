import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session-wire'
import type { AgentModelCatalogEntry } from './agent-model-catalog-store'

const SCHEMA_VERSION = 1
const SAVE_COALESCE_MS = 500

export type AgentModelCatalogPersistence = {
  load: () => Promise<AgentModelCatalogEntry[]>
  /** Fire-and-forget, coalesced; a failed write never surfaces to a caller. */
  save: (entries: readonly AgentModelCatalogEntry[]) => void
  /** Writes a coalesced save now; the delay timer is unref'd, so quit must not rely on it. */
  flush: () => Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-null `typeof === 'object'` value is indexable by string key.
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function parseEffort(value: unknown): AgentSessionOptionChoice | null {
  const row = asRecord(value)
  const effort = text(row?.value)
  const label = text(row?.label)
  if (!effort || !label) {
    return null
  }
  const description = text(row?.description)
  return { value: effort, label, ...(description ? { description } : {}) }
}

function parseModel(value: unknown): AgentSessionModelOption | null {
  const row = asRecord(value)
  const id = text(row?.id)
  const label = text(row?.label)
  if (!row || !id || !label || !Array.isArray(row.efforts)) {
    return null
  }
  const efforts = row.efforts.map(parseEffort)
  if (efforts.some((effort) => effort === null)) {
    return null
  }
  const description = text(row.description)
  const defaultEffort = text(row.defaultEffort)
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: row.isDefault === true,
    ...(defaultEffort ? { defaultEffort } : {}),
    efforts: efforts.filter((effort): effort is AgentSessionOptionChoice => effort !== null),
    ...(typeof row.supportsFastMode === 'boolean' ? { supportsFastMode: row.supportsFastMode } : {})
  }
}

/** Checked reconstruction rather than trust: a field a future schema drops or
 *  reshapes loads as "no entry", never as a corrupt catalog. */
function parseEntry(value: unknown): AgentModelCatalogEntry | null {
  const row = asRecord(value)
  if (
    !row ||
    (row.agent !== 'claude' && row.agent !== 'codex') ||
    typeof row.fingerprint !== 'string' ||
    (row.origin !== 'live-session' && row.origin !== 'probe') ||
    typeof row.fetchedAt !== 'number' ||
    !Array.isArray(row.models) ||
    row.models.length === 0
  ) {
    return null
  }
  const models = row.models.map(parseModel)
  if (models.some((model) => model === null)) {
    return null
  }
  const tiers = asRecord(row.fastModeTierByModel)
  const support = asRecord(row.fastModeSupport)
  const supported = support?.supported
  const supportReason = text(support?.reason)
  return {
    agent: row.agent,
    fingerprint: row.fingerprint,
    models: models.filter((model): model is AgentSessionModelOption => model !== null),
    ...(typeof supported === 'boolean'
      ? { fastModeSupport: { supported, ...(supportReason ? { reason: supportReason } : {}) } }
      : {}),
    fastModeTierByModel: Object.fromEntries(
      Object.entries(tiers ?? {}).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string'
      )
    ),
    origin: row.origin,
    fetchedAt: row.fetchedAt
  }
}

/** One JSON file of last-good entries. Success-only by construction: failures
 *  are never handed to `save`, and a malformed file loads as empty. */
export function createAgentModelCatalogFilePersistence(
  directory: string
): AgentModelCatalogPersistence {
  const filePath = join(directory, 'agent-model-catalog.json')
  let pending: readonly AgentModelCatalogEntry[] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing = Promise.resolve()

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const entries = pending
    pending = null
    if (!entries) {
      return writing
    }
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(filePath), { recursive: true })
        const tmpPath = `${filePath}.tmp`
        await writeFile(tmpPath, JSON.stringify({ version: SCHEMA_VERSION, entries }), 'utf8')
        await rename(tmpPath, filePath)
      } catch {
        // Bookkeeping only; the in-memory store stays authoritative this run.
      }
    })
    return writing
  }

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        const root = asRecord(parsed)
        if (!root || root.version !== SCHEMA_VERSION || !Array.isArray(root.entries)) {
          return []
        }
        return root.entries
          .map(parseEntry)
          .filter((entry): entry is AgentModelCatalogEntry => entry !== null)
      } catch {
        return []
      }
    },
    save(entries) {
      pending = [...entries]
      if (timer === null) {
        timer = setTimeout(flush, SAVE_COALESCE_MS)
        timer.unref?.()
      }
    },
    flush
  }
}
