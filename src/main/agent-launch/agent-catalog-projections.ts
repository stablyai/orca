// Env-free projections of the agent catalog: the revisioned remote snapshot
// synced to mobile/paired clients, the local (preload-IPC-only) repair summary,
// and the legacy `settings` compatibility projection for pre-catalog clients.
// No projection built here may contain a custom env key or value.

import type { CustomTuiAgent, GlobalSettings, TuiAgent } from '../../shared/types'
import type {
  AgentCatalogProjectionError,
  AgentCatalogSnapshot,
  AgentProjectionStatus,
  LocalAgentCatalogSnapshot,
  LocalAgentCatalogStorageStatus,
  LocalCustomTuiAgent,
  SyncedCustomTuiAgent
} from '../../shared/agent-catalog-snapshot'
import { MAX_LOCAL_AGENT_DRAFT_BYTES } from '../../shared/agent-catalog-snapshot'
import {
  MAX_AGENT_CATALOG_PROJECTION_BYTES,
  MAX_LOCAL_AGENT_CATALOG_BYTES,
  measureCustomAgentEnvBytes,
  normalizeAgentCatalog,
  utf8ByteLength,
  validateAgentLabel,
  type AgentCatalog,
  type CorruptCatalogRow
} from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import type { AgentCatalogRepairTokenRegistry } from './agent-catalog-mutations'

export function normalizeCatalogFromSettings(settings: GlobalSettings): AgentCatalog {
  return normalizeAgentCatalog({
    customTuiAgents: settings.customTuiAgents,
    deletedCustomTuiAgents: settings.deletedCustomTuiAgents,
    disabledTuiAgents: settings.disabledTuiAgents,
    defaultTuiAgent: settings.defaultTuiAgent
  }).catalog
}

function remoteEnvState(definition: CustomTuiAgent): 'none' | 'available' | 'withheld' {
  if (Object.keys(definition.env).length === 0) {
    return 'none'
  }
  return definition.syncEnv ? 'available' : 'withheld'
}

function hasCustomPathOverride(definition: CustomTuiAgent): boolean {
  return Object.keys(definition.env).some((key) => key.toLowerCase() === 'path')
}

function syncedRow(definition: CustomTuiAgent): SyncedCustomTuiAgent {
  const envState = remoteEnvState(definition)
  return {
    id: definition.id,
    baseAgent: definition.baseAgent,
    label: definition.label,
    ...(definition.commandOverride ? { commandOverride: definition.commandOverride } : {}),
    args: definition.args,
    syncEnv: definition.syncEnv,
    status: 'ready',
    envState,
    // Conservative: a configured executable or host-applicable env means stock
    // baseline detection cannot vouch for this row, and naming the actual
    // reason (e.g. PATH) would leak which env key exists. No executable
    // existence check runs anywhere on the launch boundary — 'launch-reported'
    // deliberately claims only that the launch itself is the availability check.
    availabilityCheck:
      definition.commandOverride || envState === 'available'
        ? 'launch-reported'
        : 'baseline-detection'
  }
}

function syncedRepairRow(row: CorruptCatalogRow): SyncedCustomTuiAgent | null {
  // Only rows with an independently valid unique id and base may project; the
  // raw invalid command/args/env never leave the host.
  if (!row.id || !row.baseAgent) {
    return null
  }
  return {
    id: row.id,
    baseAgent: row.baseAgent,
    label: row.label !== null && !validateAgentLabel(row.label) ? row.label : null,
    status: 'repair-required',
    envState: 'none'
  }
}

export function buildAgentCatalogSnapshot(
  settings: GlobalSettings,
  catalog: AgentCatalog = normalizeCatalogFromSettings(settings)
): AgentCatalogSnapshot | AgentCatalogProjectionError {
  const revision = settings.agentCatalogRevision ?? 1
  const customAgents: SyncedCustomTuiAgent[] = []
  for (const definition of catalog.liveCustomAgents) {
    customAgents.push(syncedRow(definition))
  }
  for (const row of catalog.repairRequiredById.values()) {
    const projected = syncedRepairRow(row)
    if (projected) {
      customAgents.push(projected)
    }
  }
  // Malformed/duplicate identity rows exist only in the local snapshot.
  const snapshot: AgentCatalogSnapshot = {
    version: 1,
    revision,
    defaultAgent: catalog.defaultAgent,
    disabledAgents: [...catalog.disabledAgents],
    customAgents,
    deletedCustomAgents: [...catalog.tombstonesById.values()].map((tombstone) => ({
      ...tombstone,
      // Remote clients localize a generic fallback for an unsafe label rather
      // than receiving the raw invalid text.
      label: validateAgentLabel(tombstone.label) ? '' : tombstone.label
    }))
  }
  const bytes = utf8ByteLength(JSON.stringify(snapshot))
  if (bytes > MAX_AGENT_CATALOG_PROJECTION_BYTES) {
    return {
      version: 1,
      revision,
      code: 'agent_catalog_payload_too_large',
      maxBytes: MAX_AGENT_CATALOG_PROJECTION_BYTES
    }
  }
  return snapshot
}

export function measureAgentCatalogProjection(
  settings: GlobalSettings,
  catalog: AgentCatalog = normalizeCatalogFromSettings(settings)
): AgentProjectionStatus {
  const revision = settings.agentCatalogRevision ?? 1
  const customAgents: SyncedCustomTuiAgent[] = catalog.liveCustomAgents.map(syncedRow)
  for (const row of catalog.repairRequiredById.values()) {
    const projected = syncedRepairRow(row)
    if (projected) {
      customAgents.push(projected)
    }
  }
  const snapshot: AgentCatalogSnapshot = {
    version: 1,
    revision,
    defaultAgent: catalog.defaultAgent,
    disabledAgents: [...catalog.disabledAgents],
    customAgents,
    deletedCustomAgents: [...catalog.tombstonesById.values()]
  }
  const bytes = utf8ByteLength(JSON.stringify(snapshot))
  return bytes > MAX_AGENT_CATALOG_PROJECTION_BYTES
    ? { status: 'too-large', bytes, maxBytes: MAX_AGENT_CATALOG_PROJECTION_BYTES }
    : { status: 'ready', bytes, maxBytes: MAX_AGENT_CATALOG_PROJECTION_BYTES }
}

/** Complete UTF-8 JSON size of the persisted live+tombstone custom catalog,
 *  including env (the 16 MiB local storage budget). */
export function measureLocalAgentCatalogStorage(
  settings: GlobalSettings
): LocalAgentCatalogStorageStatus {
  const bytes = utf8ByteLength(
    JSON.stringify({
      customTuiAgents: settings.customTuiAgents ?? [],
      deletedCustomTuiAgents: settings.deletedCustomTuiAgents ?? []
    })
  )
  return bytes > MAX_LOCAL_AGENT_CATALOG_BYTES
    ? { status: 'too-large', bytes, maxBytes: MAX_LOCAL_AGENT_CATALOG_BYTES }
    : { status: 'ready', bytes, maxBytes: MAX_LOCAL_AGENT_CATALOG_BYTES }
}

function localReadyRow(definition: CustomTuiAgent): LocalCustomTuiAgent {
  const { env, ...definitionWithoutEnv } = definition
  return {
    status: 'ready',
    definition: definitionWithoutEnv,
    envSummary: {
      entryCount: Object.keys(env).length,
      bytes: measureCustomAgentEnvBytes(env)
    },
    availabilityReason: definition.commandOverride
      ? 'configured-executable'
      : hasCustomPathOverride(definition)
        ? 'custom-path'
        : 'baseline-stock'
  }
}

function localRepairRow(
  row: CorruptCatalogRow,
  repairTokens: AgentCatalogRepairTokenRegistry
): LocalCustomTuiAgent {
  return {
    status: 'repair-required',
    ...(row.id ? { id: row.id } : {}),
    ...(row.baseAgent ? { baseAgent: row.baseAgent } : {}),
    label: row.label,
    repairToken: repairTokens.tokenFor(row),
    issues: row.issues.map((issue) => ({
      // Identity/baseAgent issues map onto the repair-issue DTO field names.
      field: issue.field,
      reason: issue.reason,
      ...(issue.envEntryIndex !== undefined ? { envEntryIndex: issue.envEntryIndex } : {})
    })),
    rawBytes: row.rawBytes,
    draftAvailability: row.rawBytes > MAX_LOCAL_AGENT_DRAFT_BYTES ? 'too-large' : 'available'
  }
}

export function buildLocalAgentCatalogSnapshot(
  settings: GlobalSettings,
  repairTokens: AgentCatalogRepairTokenRegistry,
  catalog: AgentCatalog = normalizeCatalogFromSettings(settings)
): LocalAgentCatalogSnapshot {
  const revision = settings.agentCatalogRevision ?? 1
  const customAgents: LocalCustomTuiAgent[] = []
  for (const definition of catalog.liveCustomAgents) {
    customAgents.push(localReadyRow(definition))
  }
  for (const row of catalog.repairRequiredById.values()) {
    customAgents.push(localRepairRow(row, repairTokens))
  }
  for (const row of catalog.corruptRows) {
    customAgents.push(localRepairRow(row, repairTokens))
  }
  const repairIssues = customAgents.flatMap((row) =>
    row.status === 'repair-required' ? row.issues : []
  )
  return {
    version: 1,
    revision,
    defaultAgent: catalog.defaultAgent,
    disabledAgents: [...catalog.disabledAgents],
    customAgents,
    deletedCustomAgents: [...catalog.tombstonesById.values()],
    repairIssues,
    projection: measureAgentCatalogProjection(settings, catalog),
    localStorage: measureLocalAgentCatalogStorage(settings)
  }
}

/** Legacy `settings.defaultTuiAgent` projection for pre-catalog clients: an old
 *  client must never receive a custom id (it cannot represent it) nor legacy
 *  null for anything but Auto (null meant auto-launch). A custom, tombstoned,
 *  or repair-needed default projects Blank — never its base — so a safe custom
 *  default cannot become a built-in launch inheriting global/YOLO args. */
export function projectLegacyDefaultTuiAgent(
  defaultAgent: TuiAgent | 'auto' | 'blank' | null | undefined
): TuiAgent | 'blank' | null {
  if (defaultAgent === 'auto') {
    return null
  }
  if (defaultAgent === 'blank' || defaultAgent === null || defaultAgent === undefined) {
    return 'blank'
  }
  return isBuiltInTuiAgent(defaultAgent) ? defaultAgent : 'blank'
}

/** Legacy disabled-list projection: omit custom ids an old client cannot render. */
export function projectLegacyDisabledTuiAgents(disabled: readonly TuiAgent[]): TuiAgent[] {
  return disabled.filter((agent) => isBuiltInTuiAgent(agent))
}
