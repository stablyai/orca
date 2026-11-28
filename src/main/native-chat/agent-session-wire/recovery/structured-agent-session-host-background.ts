import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'
import {
  readSavedUsageLimitCut,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'
import { isUsageLimitChatOpen } from './structured-agent-session-usage-limit-disposition'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'

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

/** What the status feed says of a cut: a republish of a chat that isn't open (a bot's replaced Home
 *  Chat, loaded again to move its queue) carries no usage-limit stop; reopened, it says its state. */
export function published(
  host: Pick<StructuredAgentSessionHost, 'deps'> & {
    usageLimitContinue?: Pick<StructuredAgentSessionUsageLimitContinue, 'readState'>
  },
  id: string,
  cut: HostUsageLimitCut | null
): AgentSessionStatusSummary['usageLimitContinue'] {
  return cut && isUsageLimitChatOpen(host.deps.store, id)
    ? host.usageLimitContinue?.readState(id, cut)
    : undefined
}
