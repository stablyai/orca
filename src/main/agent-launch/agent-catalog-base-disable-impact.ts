// §973 base-disable impact: the counts of persisted-owner references and
// resumable sessions that will block when a built-in base is disabled. Saved
// references include the base id and any live custom derivative of it (a
// derivative can't launch without its harness); sessions are counted by base
// and excluded from the reference scan so the two counts never overlap. Counts
// only — never a label or config. Enabled-derivative counts stay client-side.

import type { BuiltInTuiAgent, GlobalSettings } from '../../shared/types'
import type { BaseDisableImpact } from '../../shared/agent-reference-snapshot'
import type { AgentTombstoneReferenceIndex } from './agent-tombstone-reference-index'
import { normalizeCatalogFromSettings } from './agent-catalog-projections'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'

export function computeBaseDisableImpact(
  settings: GlobalSettings,
  referenceIndex: AgentTombstoneReferenceIndex,
  base: BuiltInTuiAgent
): BaseDisableImpact {
  const catalog = normalizeCatalogFromSettings(settings)
  const derivativeIds = new Set<string>()
  for (const agent of catalog.liveCustomAgents) {
    if (agent.baseAgent === base) {
      derivativeIds.add(agent.id)
    }
  }
  const matches = (value: unknown): boolean =>
    value === base || (typeof value === 'string' && derivativeIds.has(value))
  const saved = referenceIndex.countMatchingReferences(matches, {
    excludeOwners: new Set(['session'])
  })
  let resumableSessions: BaseDisableImpact['resumableSessions']
  try {
    resumableSessions = {
      count: getHostAgentSessionRecordStore().countRecordsByBase(base),
      atLeast: false
    }
  } catch {
    resumableSessions = { count: 0, atLeast: true }
  }
  return {
    savedReferences: { count: saved.count, atLeast: !saved.complete },
    resumableSessions
  }
}
