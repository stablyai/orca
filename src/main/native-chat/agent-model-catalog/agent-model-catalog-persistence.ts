import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session-wire'
import {
  agentModelCatalogEntry,
  liveLeads,
  type AgentModelCatalogEntry,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'
import { isStructuredAgentId } from '../../../shared/agent-session-provider-handle-encoding'

// 3: Codex models carry `serviceTiers`; an older file would offer Fast with no tier to send.
const SCHEMA_VERSION = 3
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

function parseChoice(value: unknown): AgentSessionOptionChoice | null {
  const row = asRecord(value)
  const choice = text(row?.value)
  const label = text(row?.label)
  if (!choice || !label) {
    return null
  }
  const description = text(row?.description)
  return { value: choice, label, ...(description ? { description } : {}) }
}

function parseModel(value: unknown): AgentSessionModelOption | null {
  const row = asRecord(value)
  const id = text(row?.id)
  const label = text(row?.label)
  if (!row || !id || !label || !Array.isArray(row.efforts)) {
    return null
  }
  const efforts = row.efforts.map(parseChoice)
  if (efforts.some((effort) => effort === null)) {
    return null
  }
  const serviceTiers = Array.isArray(row.serviceTiers)
    ? row.serviceTiers
        .map(parseChoice)
        .filter((tier): tier is AgentSessionOptionChoice => tier !== null)
    : undefined
  const description = text(row.description)
  const defaultEffort = text(row.defaultEffort)
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: row.isDefault === true,
    ...(defaultEffort ? { defaultEffort } : {}),
    efforts: efforts.filter((effort): effort is AgentSessionOptionChoice => effort !== null),
    ...(typeof row.supportsFastMode === 'boolean'
      ? { supportsFastMode: row.supportsFastMode }
      : {}),
    ...(typeof row.supportsAutoMode === 'boolean'
      ? { supportsAutoMode: row.supportsAutoMode }
      : {}),
    ...(serviceTiers ? { serviceTiers } : {})
  }
}

function parseListing(value: unknown): AgentModelCatalogListing | null {
  const row = asRecord(value)
  if (
    !row ||
    (row.origin !== 'live-session' && row.origin !== 'probe') ||
    typeof row.at !== 'number' ||
    !Array.isArray(row.models) ||
    row.models.length === 0
  ) {
    return null
  }
  const models = row.models.map(parseModel)
  if (models.some((model) => model === null)) {
    return null
  }
  const support = asRecord(row.fastModeSupport)
  const supported = support?.supported
  const supportReason = text(support?.reason)
  return {
    models: models.filter((model): model is AgentSessionModelOption => model !== null),
    ...(typeof supported === 'boolean'
      ? {
          fastModeSupport: {
            supported,
            ...(supportReason ? { reason: supportReason } : {})
          }
        }
      : {}),
    origin: row.origin,
    at: row.at,
    // Its producer is gone, so it ranks oldest; ties fall back to arrival.
    startedAt: 0
  }
}

/** Checked reconstruction rather than trust: a field a future schema drops or
 *  reshapes loads as "no entry", never as a corrupt catalog. */
function parseEntry(value: unknown): AgentModelCatalogEntry | null {
  const row = asRecord(value)
  if (!row || !isStructuredAgentId(row.agent) || typeof row.fingerprint !== 'string') {
    return null
  }
  const configured = asRecord(row.configured)
  const configuredModelId = text(configured?.modelId)
  const configuredEffort = text(configured?.effort)
  const sameModelIds = Array.isArray(configured?.sameModelIds)
    ? configured.sameModelIds.filter((id): id is string => typeof id === 'string')
    : []
  return agentModelCatalogEntry(
    row.agent,
    row.fingerprint,
    parseListing(row.discovered),
    parseListing(row.live),
    configuredModelId && typeof configured?.at === 'number'
      ? {
          modelId: configuredModelId,
          ...(sameModelIds.length > 0 ? { sameModelIds } : {}),
          ...(configuredEffort ? { effort: configuredEffort } : {}),
          at: configured.at
        }
      : null,
    0
  )
}

/** A listing as saved: its producer's start means nothing to another run. */
function persistedListing(listing: AgentModelCatalogListing | null): unknown {
  if (!listing) {
    return null
  }
  const { startedAt: _startedAt, ...saved } = listing
  return saved
}

/** Only the two listings and the configured default are written; the merged view is derived again on load. */
function persistedEntry(entry: AgentModelCatalogEntry): unknown {
  const { discovered, live } = entry
  const liveIsNewer = Boolean(liveLeads(discovered, live))
  // Starts die with this run; encode their winner without changing discovery's freshness.
  const savedLive =
    live && discovered
      ? {
          ...live,
          at: liveIsNewer ? Math.max(live.at, discovered.at) : Math.min(live.at, discovered.at - 1)
        }
      : live
  return {
    agent: entry.agent,
    fingerprint: entry.fingerprint,
    discovered: persistedListing(entry.discovered),
    live: persistedListing(savedLive),
    ...(entry.configured ? { configured: entry.configured } : {})
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
        await writeFile(
          tmpPath,
          JSON.stringify({
            version: SCHEMA_VERSION,
            entries: entries.map(persistedEntry)
          }),
          'utf8'
        )
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
