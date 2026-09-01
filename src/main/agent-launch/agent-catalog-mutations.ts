// Atomic agent-catalog mutation engine. Every mutation validates against the
// exact expected revision, produces one settings patch applied in one store
// write, and increments the catalog revision exactly once. Failures perform no
// write. Main owns id minting and dependent-field repair; corrupt rows are
// addressed only by opaque revision-scoped repair tokens. Draft validation,
// lifecycle, repair, and built-in override live in the re-exported siblings.

import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings
} from '../../shared/types'
import type { AgentCatalogMutationRequest } from '../../shared/agent-catalog-snapshot'
import { normalizeAgentCatalog, type AgentCatalog } from '../../shared/custom-tui-agents'
import type { AgentCatalogMutationApplication } from './agent-catalog-draft-validation'
import type { TombstoneReferenceCounter } from './agent-catalog-tombstone-gc'
import {
  applyCreate,
  applyDelete,
  applyDuplicate,
  applyUpdateCustom
} from './agent-catalog-lifecycle-mutations'
import { applySetDefault, applySetEnabled } from './agent-catalog-availability-mutations'
import { applyRepairCorrupt, applyResolveDuplicateId } from './agent-catalog-repair-mutations'
import type { AgentCatalogRepairTokenRegistry } from './agent-catalog-repair-mutations'
import { applyUpdateBuiltIn } from './agent-built-in-override-mutations'

export { AgentCatalogRepairTokenRegistry } from './agent-catalog-repair-mutations'
export type {
  AgentCatalogMutationError,
  AgentCatalogMutationApplication,
  TombstoneReferenceCount
} from './agent-catalog-draft-validation'

export type ApplyAgentCatalogMutationArgs = {
  settings: GlobalSettings
  request: AgentCatalogMutationRequest
  currentRevision: number
  repairTokens: AgentCatalogRepairTokenRegistry
  /** Authoritative reference count per tombstone id; 'unknown' means an owner
   *  store could not be checked and the tombstone must be retained. Accepts a
   *  batch counter so a prune indexes the owners once instead of per tombstone. */
  countTombstoneReferences: TombstoneReferenceCounter
}

export type MutationContext = {
  args: ApplyAgentCatalogMutationArgs
  catalog: AgentCatalog
  persistedLive: readonly unknown[]
  persistedTombstones: readonly DeletedCustomTuiAgent[]
  newRevision: number
}

function definitionsEqualById(
  agents: readonly CustomTuiAgent[]
): Map<CustomTuiAgentId, CustomTuiAgent> {
  const map = new Map<CustomTuiAgentId, CustomTuiAgent>()
  for (const agent of agents) {
    map.set(agent.id, agent)
  }
  return map
}

export function applyAgentCatalogMutation(
  args: ApplyAgentCatalogMutationArgs
): AgentCatalogMutationApplication {
  const { settings, request, currentRevision, repairTokens } = args
  if (request.expectedRevision !== currentRevision) {
    return { ok: false, code: 'catalog_revision_conflict' }
  }

  const { catalog } = normalizeAgentCatalog({
    customTuiAgents: settings.customTuiAgents,
    deletedCustomTuiAgents: settings.deletedCustomTuiAgents,
    disabledTuiAgents: settings.disabledTuiAgents,
    defaultTuiAgent: settings.defaultTuiAgent
  })
  const persistedLive = Array.isArray(settings.customTuiAgents) ? settings.customTuiAgents : []
  const persistedTombstones = Array.isArray(settings.deletedCustomTuiAgents)
    ? settings.deletedCustomTuiAgents
    : []
  const newRevision = currentRevision + 1
  const mutation = request.mutation
  const context: MutationContext = {
    args,
    catalog,
    persistedLive,
    persistedTombstones,
    newRevision
  }

  switch (mutation.kind) {
    case 'create':
      return applyCreate(mutation.baseAgent, mutation.draft, context)
    case 'duplicate':
      return applyDuplicate(mutation.sourceAgent, mutation.label, context)
    case 'update-custom':
      return applyUpdateCustom(mutation.id, mutation.changes, context)
    case 'delete-custom':
      return applyDelete(mutation.id, mutation.onDefault ?? 'keep', context)
    case 'set-enabled':
      return applySetEnabled(mutation.agent, mutation.enabled, { args, catalog, newRevision })
    case 'set-default':
      return applySetDefault(mutation.agent, catalog, newRevision)
    case 'repair-corrupt':
      return applyRepairCorrupt(mutation.repairToken, mutation.action, {
        ...context,
        repairTokens
      })
    case 'resolve-duplicate-id':
      return applyResolveDuplicateId(mutation.duplicateId, mutation.rows, {
        ...context,
        repairTokens
      })
    case 'update-built-in':
      return applyUpdateBuiltIn(mutation, settings, newRevision)
  }
}

export function liveDefinitionsById(
  settings: GlobalSettings
): Map<CustomTuiAgentId, CustomTuiAgent> {
  const { catalog } = normalizeAgentCatalog({
    customTuiAgents: settings.customTuiAgents,
    deletedCustomTuiAgents: settings.deletedCustomTuiAgents,
    disabledTuiAgents: settings.disabledTuiAgents,
    defaultTuiAgent: settings.defaultTuiAgent
  })
  return definitionsEqualById(catalog.liveCustomAgents)
}
