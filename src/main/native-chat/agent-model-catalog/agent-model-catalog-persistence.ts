import { join } from 'node:path'
import {
  readLegacyJsonSource,
  removeImportedLegacyJsonSource
} from '../../sqlite/legacy-json-source'
import { KeyedJsonRowCache, type KeyedJsonRow } from '../../sqlite/keyed-json-row-cache'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import {
  agentModelCatalogEntry,
  serializedAgentModelCatalogListing,
  type AgentModelCatalogEntry,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'
import { isStructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

// Older catalogs lack serviceTiers and cannot safely construct Fast requests.
const SCHEMA_VERSION = 3
const SAVE_COALESCE_MS = 500
const MAX_RETRY_DELAY_MS = 60_000

export type AgentModelCatalogPersistence = {
  load: () => Promise<AgentModelCatalogEntry[]>
  /** Coalesce saves; failures leave the in-memory store authoritative. */
  save: (snapshot: () => readonly AgentModelCatalogEntry[]) => void
  /** Flush at quit because the delayed-save timer is unref'd. */
  flush: () => Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
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
  const resolvedModel = text(row.resolvedModel)
  return {
    id,
    label,
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(row.effortsKnown === false ? { effortsKnown: false as const } : {}),
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
    ...(serviceTiers ? { serviceTiers } : {}),
    ...(Array.isArray(row.chatEfforts)
      ? {
          chatEfforts: row.chatEfforts
            .map(parseChoice)
            .filter((choice): choice is AgentSessionOptionChoice => choice !== null)
        }
      : {})
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
    ...(row.complete === true ? { complete: true } : {})
  }
}

/** Reject incompatible rows rather than trusting persisted schema shapes. */
function parseEntry(value: unknown): AgentModelCatalogEntry | null {
  const row = asRecord(value)
  if (!row || !isStructuredAgentId(row.agent) || typeof row.fingerprint !== 'string') {
    return null
  }
  if (row.agent === 'claude' || row.agent === 'codex') {
    const display = parseListing(row.discovered) ?? parseListing(row.live)
    return agentModelCatalogEntry(row.agent, row.fingerprint, display, null, null)
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
      : null
  )
}

// Persist source listings/default facts; derive the merged view on load.
function persistedEntry(entry: AgentModelCatalogEntry): unknown {
  return {
    agent: entry.agent,
    fingerprint: entry.fingerprint,
    discovered: serializedAgentModelCatalogListing(entry.discovered),
    live: serializedAgentModelCatalogListing(entry.live),
    ...(entry.configured ? { configured: entry.configured } : {})
  }
}

function parseEntries(values: readonly unknown[]): AgentModelCatalogEntry[] {
  return values.map(parseEntry).filter((entry): entry is AgentModelCatalogEntry => entry !== null)
}

function catalogRow(entry: AgentModelCatalogEntry): KeyedJsonRow {
  return {
    key: `${entry.agent}\u0000${entry.fingerprint}`,
    json: JSON.stringify(persistedEntry(entry))
  }
}

/** Rows of an older build's file; bytes it cannot use (corrupt, other version) yield none. */
function legacyRows(text: string): KeyedJsonRow[] {
  let root: Record<string, unknown> | null
  try {
    root = asRecord(JSON.parse(text))
  } catch {
    return []
  }
  if (!root || root.version !== SCHEMA_VERSION || !Array.isArray(root.entries)) {
    return []
  }
  return root.entries
    .map(parseEntry)
    .filter((entry): entry is AgentModelCatalogEntry => entry !== null)
    .map(catalogRow)
}

/** One row per catalog entry, so a save writes only the entries whose listing changed. */
export function createAgentModelCatalogFilePersistence(
  directory: string
): AgentModelCatalogPersistence {
  // Earlier builds rewrote this whole file (megabytes) per change; it is imported once, then removed.
  const legacyPath = join(directory, 'agent-model-catalog.json')
  // Stored state could not be read: this session makes no legacy-vs-stored decision and
  // saves nothing, leaving both for the next start. Rediscovery refills memory meanwhile.
  let cold = false
  const cache = new KeyedJsonRowCache(join(directory, 'agent-model-catalog.db'), SCHEMA_VERSION)
  let pending: (() => readonly AgentModelCatalogEntry[]) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let retryDelayMs = SAVE_COALESCE_MS

  const schedule = (delayMs: number): void => {
    timer ??= setTimeout(flush, delayMs)
    timer.unref?.()
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const snapshot = pending
    pending = null
    if (snapshot && !cold) {
      try {
        cache.write(snapshot().map(catalogRow))
        retryDelayMs = SAVE_COALESCE_MS
      } catch {
        // Optional bookkeeping (a lock elsewhere, a full disk): memory stays authoritative and
        // the latest snapshot is retried later unless a newer save replaces it.
        pending ??= snapshot
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
        schedule(retryDelayMs)
      }
    }
    return Promise.resolve()
  }

  return {
    async load() {
      const source = readLegacyJsonSource(legacyPath)
      // An unreadable file stays, as does the stored catalog; the next start tries again.
      const legacy =
        source.kind === 'read'
          ? { rows: legacyRows(source.text), receipt: source.receipt }
          : undefined
      // A file still present came from an older build unless its receipt shows it was imported.
      const loaded = cache.load(legacy)
      if (loaded.kind === 'unreadable') {
        cold = true
        return []
      }
      if (legacy) {
        removeImportedLegacyJsonSource(legacyPath, legacy.receipt)
      }
      return parseEntries(loaded.values)
    },
    save(snapshot) {
      pending = snapshot
      schedule(SAVE_COALESCE_MS)
    },
    flush
  }
}
