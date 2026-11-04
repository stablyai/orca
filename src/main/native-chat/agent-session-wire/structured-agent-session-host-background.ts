import { restoreJournalAsync } from '../agent-session-journal/journal-async-open'
import { renderJournalStatus } from '../agent-session-journal/journal-public-read'
import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'

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

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
async function readSavedUsageLimitCut(
  db: JournalHostDatabase,
  id: string
): Promise<NativeChatUsageLimitCut | null> {
  const load = await db.read((read) => restoreJournalAsync(read, id))
  const snapshot =
    load && !load.newer && !load.damage
      ? renderJournalStatus(load.state, journalInputOrder(load.state))
      : null
  return snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
}
