import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type { AgentModelCatalogFailures } from './agent-model-catalog-failures'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'
import type { createAgentModelEffortDiscovery } from './agent-model-catalog-effort-discovery'
import {
  agentModelCatalogEntryWithSuccess,
  agentModelCatalogListingKey,
  type AgentModelCatalogEntry,
  type AgentModelCatalogSuccess,
  type AgentModelCatalogSource
} from './agent-model-catalog-entry'

export function agentModelCatalogEntryIsStale(
  entry: AgentModelCatalogEntry,
  due: boolean
): boolean {
  return due || !entry.discovered
}

export function recordAgentModelCatalogPartialAttempt(
  attempts: Map<string, { agent: string; at: number }>,
  key: string,
  agent: string,
  now: number,
  cap: number
): void {
  attempts.set(key, { agent, at: now })
  while (attempts.size > cap) {
    const oldest = attempts.keys().next().value
    if (oldest !== undefined) {
      attempts.delete(oldest)
    }
  }
}

export function agentModelEffortProbeDue(
  entry: AgentModelCatalogEntry | undefined,
  attempts: Map<string, { agent: string; at: number }>,
  model: string | undefined
): boolean {
  if (!model || !entry || !usesModelSpecificAcpEfforts(entry.agent)) {
    return false
  }
  return (
    entry.models.some((row) => row.id === model && row.effortsKnown === false) &&
    !attempts.has(JSON.stringify([entry.fingerprint, model]))
  )
}

export function evictAgentModelCatalogEntries(
  entries: Map<string, AgentModelCatalogEntry>,
  dueEntries: Set<string>,
  partialAttempts: Map<string, { agent: string; at: number }>,
  cap: number,
  retiredObservations: Set<string>
): void {
  for (const key of entries.keys()) {
    if (entries.size <= cap) {
      return
    }
    entries.delete(key)
    dueEntries.delete(key)
    partialAttempts.delete(key)
    retiredObservations.delete(key)
  }
}

export function retireAgentModelCatalogObservations(
  entries: ReadonlyMap<string, AgentModelCatalogEntry>,
  dueEntries: Set<string>,
  retiredObservations: Set<string>,
  partialAttempts: Map<string, { agent: string; at: number }>,
  agent: string
): void {
  for (const entry of entries.values()) {
    if (entry.agent === agent) {
      dueEntries.add(entry.fingerprint)
      retiredObservations.add(entry.fingerprint)
    }
  }
  for (const [key, attempt] of partialAttempts) {
    if (attempt.agent === agent) {
      partialAttempts.delete(key)
    }
  }
}

export function agentModelCatalogLaunchAgents(
  revisions: ReadonlyMap<string, number>,
  entries: ReadonlyMap<string, AgentModelCatalogEntry>
): Set<string> {
  return new Set([...revisions.keys(), ...[...entries.values()].map((entry) => entry.agent)])
}

export function createAgentModelCatalogEntryFactory(
  entries: ReadonlyMap<string, AgentModelCatalogEntry>,
  retiredObservations: ReadonlySet<string>,
  now: () => number
) {
  return (
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ) =>
    agentModelCatalogEntryWithSuccess(
      retiredObservations.has(fingerprint) ? undefined : entries.get(fingerprint),
      { agent, fingerprint },
      success,
      source,
      now()
    )
}

function writeAgentModelCatalogSuccess(
  state: {
    entries: Map<string, AgentModelCatalogEntry>
    retiredObservations: Set<string>
    dueEntries: Set<string>
    failures: AgentModelCatalogFailures
    efforts: ReturnType<typeof createAgentModelEffortDiscovery>
    entryFromSuccess: ReturnType<typeof createAgentModelCatalogEntryFactory>
    persistence: AgentModelCatalogPersistence | null
    evict: () => void
  },
  fingerprint: string,
  agent: string,
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource
): AgentModelCatalogEntry | null {
  const entry = state.entryFromSuccess(fingerprint, agent, success, source)
  if (!entry) {
    if (source === 'discovery' && independentAgentModelCatalog(agent)) {
      state.failures.probeFailed(fingerprint, agent, new Error('agent listed no models'))
    }
    return null
  }
  state.retiredObservations.delete(fingerprint)
  const previous = state.entries.get(fingerprint)
  state.entries.delete(fingerprint)
  state.entries.set(fingerprint, entry)
  // Live listings cannot clear discovery failures or account-unavailability verdicts.
  if (source === 'discovery') {
    state.dueEntries.delete(fingerprint)
    state.failures.listed(fingerprint, agent, success.origin, success.unavailable)
  }
  if (source === 'discovery' && independentAgentModelCatalog(agent)) {
    state.efforts.catalogAttempted(fingerprint, agent, success.complete === true)
    if (success.complete !== true) {
      state.failures.listed(fingerprint, agent, success.origin, success.unavailable)
    }
  }
  state.evict()
  // Unchanged per-turn listings need no disk write.
  if (!previous || agentModelCatalogListingKey(previous) !== agentModelCatalogListingKey(entry)) {
    state.persistence?.save(() => [...state.entries.values()])
  }
  return entry
}

export function createAgentModelCatalogSuccessWriter(
  readState: () => Parameters<typeof writeAgentModelCatalogSuccess>[0]
): ReturnType<typeof createAgentModelCatalogEntryFactory> {
  return (fingerprint, agent, success, source) =>
    writeAgentModelCatalogSuccess(readState(), fingerprint, agent, success, source)
}
