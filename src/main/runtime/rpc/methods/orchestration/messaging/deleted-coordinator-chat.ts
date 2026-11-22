// A Run's coordinating chat that was deleted: its Run still names it, so a worker's new ask there
// has no reader. A Chat `/new` replaced isn't counted: nothing durable tells it from a bot's live
// thread chats, so its open asks are told at the reset instead.
import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import { currentRunCoordinatorOrcaSessionId } from '../../../../orchestration/db/runs/run-coordinator-orca-session'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** The Run's coordinating chat when it was deleted; undefined when it may still read, or when the
 *  chats can't be read yet (a later ask, or the coordinator's own edges, decide then). */
export function deletedCoordinatorChat(run: RunRow): string | undefined {
  const coordinator = currentRunCoordinatorOrcaSessionId(run)
  const host = getStructuredAgentSessionHost()
  if (!coordinator || !host) {
    return undefined
  }
  return host.deps.store.getConversation(coordinator) ? undefined : coordinator
}
