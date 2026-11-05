import { restoreJournalAsync } from '../agent-session-journal/journal-open'
import { renderJournalStatus } from '../agent-session-journal/journal-public-read'
import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export async function readSavedUsageLimitCut(
  database: JournalHostDatabase,
  id: string
): Promise<NativeChatUsageLimitCut | null> {
  const load = await database.read((read) => restoreJournalAsync(read, id))
  const snapshot =
    load && !load.newer && !load.damage
      ? renderJournalStatus(load.state, journalInputOrder(load.state))
      : null
  return snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
}
