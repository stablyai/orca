import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { restoreJournal } from '../../agent-session-journal/replay/journal-open'
import { renderJournalStatus } from '../../agent-session-journal/projection/journal-public-read'
import { journalInputOrder } from '../../agent-session-journal/input-order/journal-input-order'
import type Database from '../../../sqlite/sync-database'

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export function readSavedUsageLimitCut(
  db: Database.Database,
  id: string
): NativeChatUsageLimitCut | null {
  const load = restoreJournal(db, id)
  const snapshot =
    load && !load.newer && !load.damage
      ? renderJournalStatus(load.state, journalInputOrder(load.state))
      : null
  return snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
}
