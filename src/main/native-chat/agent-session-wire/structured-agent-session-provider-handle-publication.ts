import type { StructuredAgentSessionProviderOpenResult } from './structured-agent-session-provider-open-contract'
import type { StructuredAgentSessionProviderStartedContext } from './structured-agent-session-provider-started'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session/ownership/agent-session-provider-handle-transition'

export type OpenedProvider = StructuredAgentSessionProviderOpenResult & {
  sessionId: string
  fence: number
  acquisitionGeneration: string
}

/** Persist the opened handle before delivery so future starts can resume; false if no handle is proven. */
export async function recordStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an already-proven handle permits open without a new link.
    return store.getRecord(event.sessionId)?.lease.provenHandleLinkId != null
  }
  try {
    const committed = await store.transitionHandoff(event.sessionId, (record) =>
      recordAgentSessionProviderHandle({ record, fence: event.fence, link, now: context.now() })
    )
    // Inherit only a committed new context; a resumed CLI keeps its own later title.
    if (event.newConversation ?? (link.origin === 'created' || link.origin === 'forked')) {
      context.deps.nameProviderConversation?.(committed)
    }
    return true
  } catch (error) {
    logger.warn('recording the handle a started provider answered with failed', {
      scope: 'provider-started-handle',
      sessionId: event.sessionId,
      error
    })
    return false
  }
}
