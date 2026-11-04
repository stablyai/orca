import type Database from '../../sqlite/sync-database'
import { restoreJournal } from '../agent-session-journal/journal-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export function readSavedUsageLimitCut(
  db: Database.Database,
  id: string
): (NativeChatUsageLimitCut & { personalStop?: true }) | null {
  const load = restoreJournal(db, id)
  const snapshot = load && !load.newer && !load.damage ? renderJournalState(load.state) : null
  const cut = snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
  return cut && load
    ? {
        ...cut,
        ...(load.state.derivedTurnScope.cancellations.history(load.state, cut.turnItemId)?.userStop
          ? { personalStop: true as const }
          : {})
      }
    : null
}
