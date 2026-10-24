// Warm catalogs from listings; only startup/readback resolves defaults, and bookkeeping must not reject valid actions.

import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'

export type StructuredAgentSessionStartListingContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'modelCatalog' | 'logger'>
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
}

export function saveStructuredAgentSessionListing(
  context: Pick<StructuredAgentSessionStartListingContext, 'deps'>,
  sessionId: string,
  listing: AgentModelCatalogLiveListing
): void {
  try {
    context.deps.modelCatalog?.recordLiveListing(sessionId, listing)
  } catch (error) {
    context.deps.logger.warn('saving what a provider listed failed', {
      scope: 'provider-catalog',
      sessionId,
      error
    })
  }
}

/** Serialize delayed settings readback behind attach publication before resolving the configured default. */
export function saveStructuredAgentSessionStartReadbackListing(
  context: StructuredAgentSessionStartListingContext,
  reporter: { sessionId: string; acquisitionGeneration: string; fence: number },
  listing: AgentModelCatalogLiveListing
): Promise<void> {
  const { sessionId } = reporter
  return context
    .serialize(sessionId, async () => {
      const child = context.sessions.get(sessionId)?.child
      const identity = { generation: reporter.acquisitionGeneration, fence: reporter.fence }
      if (child && sameProviderChild(child, identity)) {
        context.deps.modelCatalog?.recordLiveListing(sessionId, listing)
      }
    })
    .catch((error: unknown) => {
      context.deps.logger.warn('saving what a started provider resolved failed', {
        scope: 'provider-started-catalog',
        sessionId,
        error
      })
    })
}
