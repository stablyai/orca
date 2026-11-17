import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import { traceAccountMove } from './structured-agent-session-account-move-trace'
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
    readSavedCut: (id) => readSavedUsageLimitCut(context.deps.journalDatabase, id),
    serialize: context.serialize,
    send: (params) => host.send({ callerKey: 'trusted-local:usage-limit-continue' }, params),
    publish: delivery.publishStatus,
    now: context.now,
    // A read, outside the chat's lane: one busy chat must not delay every other continue.
    awaitsAccountMove: async (id, launchHome) =>
      !!(await context.accountTransition?.(id, { launchHome, observe: false }))
  })
  limit.start()
  return limit
}

/** Settled background work can release a card waiting for an account move. */
export function childWorkChanged(
  tasks: { publish: (id: string) => void },
  queued: { accountMoveEvidence: (id: string) => void },
  delivery: Pick<StructuredAgentSessionClientDelivery, 'childWorkOpen'>,
  id: string
): void {
  tasks.publish(id)
  traceAccountMove('childWorkChanged', 'open', delivery.childWorkOpen(id))
  if (!delivery.childWorkOpen(id)) {
    queued.accountMoveEvidence(id)
  }
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
