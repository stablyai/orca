import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  readSavedUsageLimitCut,
  StructuredAgentSessionUsageLimitContinue
} from './structured-agent-session-usage-limit-continue'

export function start(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'send'>,
  delivery: Pick<StructuredAgentSessionClientDelivery, 'publishStatus' | 'readUsageLimitCut'>
): StructuredAgentSessionUsageLimitContinue {
  const limit = new StructuredAgentSessionUsageLimitContinue({
    host: context.deps,
    sessions: context.sessions,
    readLoadedCut: (id) => {
      const cut = delivery.readUsageLimitCut(id)
      return cut
        ? {
            ...cut,
            ...(context.sessions.get(id)?.journal.stopMarks.userStopRequestedForItem(cut.turnItemId)
              ? { personalStop: true as const }
              : {})
          }
        : null
    },
    readSavedCut: (id) => readSavedUsageLimitCut(context.deps.journalDatabase.db, id),
    serialize: context.serialize,
    send: (params) => host.send({ callerKey: 'trusted-local:usage-limit-continue' }, params),
    publish: delivery.publishStatus,
    now: context.now
  })
  limit.start()
  return limit
}

/** A reopened chat re-reads its cut from the loaded journal. */
export function opened(
  limit: Pick<StructuredAgentSessionUsageLimitContinue, 'forget'> | undefined,
  queued: { onOpened: (id: string) => void },
  id: string
): void {
  limit?.forget(id)
  queued.onOpened(id)
}
