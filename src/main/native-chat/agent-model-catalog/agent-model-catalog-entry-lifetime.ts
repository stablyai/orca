import {
  agentModelCatalogEntryWithSuccess,
  type AgentModelCatalogEntry,
  type AgentModelCatalogSuccess,
  type AgentModelCatalogSource
} from './agent-model-catalog-entry'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000

export function agentModelCatalogEntryIsStale(
  entry: AgentModelCatalogEntry,
  due: boolean,
  now: number
): boolean {
  return (
    due ||
    !entry.discovered ||
    (independentAgentModelCatalog(entry.agent) && entry.discovered.complete !== true) ||
    now - entry.discovered.at >=
      (independentAgentModelCatalog(entry.agent) ? 2 * 60_000 : AGENT_MODEL_CATALOG_FRESH_MS)
  )
}

export function pruneAgentModelCatalogPartialAttempts(
  attempts: Map<string, { agent: string; at: number }>,
  now: number
): void {
  for (const [key, attempt] of attempts) {
    if (now - attempt.at >= 2 * 60_000) {
      attempts.delete(key)
    }
  }
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
