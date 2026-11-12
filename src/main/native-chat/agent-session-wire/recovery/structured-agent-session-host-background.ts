import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'
import { readSavedUsageLimitCut } from './structured-agent-session-usage-limit-chain'

export function start(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'send'>,
  delivery: Pick<StructuredAgentSessionClientDelivery, 'publishStatus' | 'readUsageLimitCut'>
): StructuredAgentSessionUsageLimitContinue {
  const limit = new StructuredAgentSessionUsageLimitContinue({
    host: context.deps,
    sessions: context.sessions,
    readLoadedCut: delivery.readUsageLimitCut,
    readSavedCut: (id) => readSavedUsageLimitCut(context.deps.journalDatabase.db, id),
    cutAccountHome: async (id, turnItemId) => {
      // Only the child that ran the cut's turn knows its account, so save it while that child is live.
      const session = context.sessions.get(id)
      const child = session?.child
      if (child?.accountHome && session?.journal.itemFence(turnItemId) === child.fence) {
        const accountHome = child.accountHome
        await context.deps.store.recordUsageLimitCutAccount(id, { turnItemId, accountHome })
        return accountHome
      }
      const saved = context.deps.store.getRecord(id)?.usageLimitCutAccount
      return saved?.turnItemId === turnItemId ? saved.accountHome : null
    },
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
