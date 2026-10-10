// What a start listed reaches the account's model catalog once, with the configured default its
// start resolved: on `started`, or on Claude's settings readback that follows it. Bookkeeping: a
// failure is logged, never the start's.

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

/** A proven start's listing, saved inside its serialized step. */
export function saveStructuredAgentSessionStartListing(
  context: Pick<StructuredAgentSessionStartListingContext, 'deps'>,
  sessionId: string,
  listing: AgentModelCatalogLiveListing
): void {
  try {
    context.deps.modelCatalog?.recordLiveListing(sessionId, listing)
  } catch (error) {
    context.deps.logger.warn('saving what a started provider listed failed', {
      scope: 'provider-started-catalog',
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
