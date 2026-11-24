import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'
import { keepsRicherAgentModelListing } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'

/** How soon a read lists again after a probe that lacked rows this process saw. */
export const AGENT_MODEL_CATALOG_SHORT_LISTING_RELIST_MS = 5 * 60 * 1000

/** Rows chats and probes listed in this process, the newest copy of each; never saved, so a
 *  restart starts over (#46905). */
export type SeenAgentModelRows = {
  models: AgentSessionModelOption[]
  relistAfter?: number
}

/** A probe at least as long as what was seen replaces it. A shorter one, or a chat's listing, adds
 *  to it; after a shorter probe the next read lists again in 5 minutes. */
export function seenAgentModelRows(
  agent: string,
  previous: SeenAgentModelRows | undefined,
  listed: readonly AgentSessionModelOption[],
  source: 'discovery' | 'live',
  at: number
): SeenAgentModelRows | undefined {
  if (!keepsRicherAgentModelListing(agent)) {
    return undefined
  }
  const seen = previous?.models ?? []
  if (source === 'discovery' && listed.length >= seen.length) {
    return { models: [...listed] }
  }
  const relistAfter =
    source === 'discovery'
      ? at + AGENT_MODEL_CATALOG_SHORT_LISTING_RELIST_MS
      : previous?.relistAfter
  return {
    models: [...seen.filter((row) => !listed.some((model) => model.id === row.id)), ...listed],
    ...(relistAfter !== undefined ? { relistAfter } : {})
  }
}

/** The earliest time a write after `previous` may carry. */
export function seenRowsTiebreak(
  agent: string,
  previous: AgentModelCatalogEntry | undefined
): number {
  return keepsRicherAgentModelListing(agent) && previous ? previous.fetchedAt + 1 : -Infinity
}

/** The entry with `seen`: its listings' rows, then the seen rows they lack. */
export function withSeenRows(
  entry: AgentModelCatalogEntry | null,
  seen: SeenAgentModelRows | undefined
): AgentModelCatalogEntry | null {
  if (!entry || !seen) {
    return entry
  }
  const missing = seen.models.filter((row) => !entry.models.some((model) => model.id === row.id))
  return {
    ...entry,
    models: [...entry.models, ...missing.map((row) => ({ ...row, isDefault: false }))],
    seen
  }
}
