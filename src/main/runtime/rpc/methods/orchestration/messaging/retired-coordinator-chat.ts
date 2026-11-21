// A Run's coordinating chat that no one will read for again: a bot's Chat that `/new` replaced, or
// a chat that was deleted. Its Run still names it, so a worker's new ask there has no reader.
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import { currentRunCoordinatorOrcaSessionId } from '../../../../orchestration/db/runs/run-coordinator-orca-session'
import { createChatOrcaSessionIdResolver } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { botOfSession } from '../../../../../bots/bot-session-tabs'

/** The Run's coordinating chat when it is retired; undefined when it may still read, or when the
 *  chats can't be read yet (a later ask, or the coordinator's own edges, decide then). */
export function retiredCoordinatorChat(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  run: RunRow
): string | undefined {
  const coordinator = currentRunCoordinatorOrcaSessionId(run)
  const host = getStructuredAgentSessionHost()
  if (!coordinator || !host) {
    return undefined
  }
  if (!host.deps.store.getConversation(coordinator)) {
    return coordinator
  }
  const bot = botOfSession(runtime.bots, coordinator, host)
  const root = createChatOrcaSessionIdResolver()
  return bot && bot.chatSessionId && root(bot.chatSessionId) !== root(coordinator)
    ? coordinator
    : undefined
}
