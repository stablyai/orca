import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { toSqliteUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'
import type { AgentJournalSnapshot } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  describeTerminalHostCapRefusal,
  readTerminalHostCapRefusal
} from '../../../../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { StructuredAgentSessionRequestFailure } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import type { ChatRequestError } from '../../../../orchestration/workers/turn-stops/chat-worker-error-words'

// The chat's own newest starts; a turn that failed on the cap made one of them.
const RECENT_STARTS = 20

function turnStartedAt(snapshot: AgentJournalSnapshot | null, turnId: string): number | null {
  const item = snapshot?.items.find(
    (entry) =>
      isRootAgentJournalItem(entry) &&
      entry.itemId === turnId &&
      readAgentJournalTurn(entry.body) !== null
  )
  return item ? (readAgentJournalTurn(item.body)?.startedAt ?? item.observedAt) : null
}

/** A worker start this chat made during the failed turn that the host refused at its terminal cap. */
function refusedStartInTurn(
  db: OrchestrationDb,
  sessionId: string,
  startedAt: number
): ReturnType<typeof readTerminalHostCapRefusal> {
  // Second precision, like the rows it is compared with.
  const since = toSqliteUtcTimestamp(startedAt)
  for (const dispatchId of db.listDispatchIdsCreatedBySession(sessionId, RECENT_STARTS)) {
    const worker = db.getWorkerDispatch(dispatchId)
    if (worker?.state === 'failed' && worker.created_at >= since) {
      const refusal = readTerminalHostCapRefusal(worker.last_error)
      if (refusal) {
        return refusal
      }
    }
  }
  return null
}

/** Why a chat's request failed, naming the host's terminal cap when that is what refused its work.
 *  A typed failure, such as a usage limit, is the turn's own reason and stands. */
export async function failureNamingHostCap(
  db: OrchestrationDb,
  failure: StructuredAgentSessionRequestFailure,
  error: ChatRequestError | null
): Promise<string | undefined> {
  const recorded = readTerminalHostCapRefusal(error?.text)
  if (recorded) {
    return describeTerminalHostCapRefusal(recorded)
  }
  if (error?.kind || failure.kind !== 'turn') {
    return error?.text
  }
  const startedAt = turnStartedAt(await failure.read(), failure.id)
  const refused = startedAt === null ? null : refusedStartInTurn(db, failure.sessionId, startedAt)
  return refused
    ? describeTerminalHostCapRefusal(refused, 'the terminal of a worker it started')
    : error?.text
}
