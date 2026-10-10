import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentModelCatalogService } from './agent-model-catalog-service'
import { AGENT_MODEL_CATALOG_START_WAIT_MS } from './agent-model-catalog-store'
import type { StructuredAgentRegistry } from '../agent-session-wire/structured-agent-registry'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { isReplaceableModelChoice } from '../../../shared/agent-session-options-replacement'
import {
  nearestAgentEffort,
  unlistedAgentModelReplacement
} from '../../../shared/agent-session-model-fallback'

/** The saved options a chat runs, judged against the host's catalog answer: a model a current list
 *  no longer offers gives way to the host's replacement, its effort carried to the nearest level
 *  that model offers. Any doubt keeps the selection as saved. */
export function settledAgentModelSelection(
  catalog: AgentSessionModelCatalogResult,
  saved: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (catalog.origin === 'unknown') {
    return saved
  }
  const replacement = unlistedAgentModelReplacement(
    catalog.models,
    saved.model,
    catalog.unlistedModelReplacement
  )
  if (!replacement) {
    return saved
  }
  const { effort, ...rest } = saved
  const offered = catalog.models.find((model) => model.id === replacement)?.efforts ?? []
  const carried = nearestAgentEffort(
    effort,
    offered.map((choice) => choice.value)
  )
  return { ...rest, model: replacement, ...(carried ? { effort: carried } : {}) }
}

/** The saved options a start launches with, decided as an at-rest read is. Only the user's own
 *  selection (a pick or the new-chat default), for an agent whose host replaces a gone one, is read
 *  against the catalog at all, and the catalog never gates a start: no catalog, a failed read, or a
 *  read slower than the start's short wait launches the selection as saved. */
export async function agentModelLaunchOptions(
  catalog: Pick<AgentModelCatalogService, 'read'> | undefined,
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId' | 'options' | 'modelChosenBy'>
): Promise<Readonly<Record<string, string>> | undefined> {
  const saved = record.options
  if (
    !catalog ||
    !saved?.model ||
    !isReplaceableModelChoice(record.modelChosenBy) ||
    agents.definition(record.provider)?.restingOptions.replacesUnlistedModel !== true
  ) {
    return saved
  }
  // The whole read, the workspace-config checks it may wait on included.
  const answer = await withTimeout<AgentSessionModelCatalogResult | null>(
    catalog.read({ agent: record.provider, sessionId: record.sessionId, forStart: true }),
    AGENT_MODEL_CATALOG_START_WAIT_MS,
    null
  )
  return answer ? settledAgentModelSelection(answer, saved) : saved
}
