// Session listings warm the account catalog; only startup/readback also resolves its default.
// Catalog bookkeeping failures never reject the session action that supplied the listing.

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

/** Catalog persistence must not reject a valid start or options answer. */
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

/** A start's late readback (Claude's settings) says once what the config resolved. Serialized
 *  behind the attach that published the child, which may still be indexing it. */
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
