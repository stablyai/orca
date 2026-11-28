// The record store's deletions: a chat at rest the deleted-workspace sweep forgets, and the user's
// Delete chat, which forgets a whole /clear lineage and keeps its tombstone for good.
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { DeletedChats, type DeletedChat } from '../../../native-chat/chat-deletion/deleted-chats'
import type { AgentSessionChatForget, AgentSessionIdleForget } from './agent-session-record-forget'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { AgentSessionRecordTabs } from './agent-session-tab-table'

/** Every deleted chat's tombstone, read once as the store opens. */
export async function readDeletedChats(
  journalDatabase: JournalSqlDatabase
): Promise<DeletedChat[]> {
  const result = await journalDatabase.readers.database({ kind: 'deleted-chats' })
  if (result.kind !== 'deleted-chats') {
    throw new Error('journal reader returned no deleted chats')
  }
  return result.chats
}

export abstract class AgentSessionRecordForgets extends AgentSessionRecordTabs {
  /** Deleted chats: their ids are never reused, their conversations never listed or adopted. */
  readonly deletedChats: DeletedChats

  constructor(
    transactions: AgentSessionStoreTransactions,
    protected readonly journalDatabase: JournalSqlDatabase,
    deletedChats: readonly DeletedChat[]
  ) {
    super(transactions)
    this.deletedChats = new DeletedChats(deletedChats)
  }

  /** The chats that hold a message by this id: a send Orca lost track of, found again by its id. */
  chatsHoldingMessage = async (messageId: string): Promise<string[]> => {
    const read = await this.journalDatabase.readers.database({ kind: 'message-chats', messageId })
    if (read.kind !== 'message-chats') {
      throw new Error('journal reader returned no chats')
    }
    return read.sessionIds
  }

  protected refuseDeletedSession(sessionId: string): void {
    if (this.deletedChats.hasSession(sessionId)) {
      throw new Error('agent_session_deleted')
    }
  }

  /** Deletes a chat at rest for good, with its tab, when `stillWanted` agrees after any conversion
   *  of it. Its journal rows follow in background pages on the next maintenance tick, so a batch
   *  of deletions shares one pass. The caller holds the chat's conversation lane, so nothing opens
   *  it meanwhile. */
  forgetIdleChat = (
    forget: AgentSessionIdleForget,
    stillWanted: () => Promise<boolean>
  ): Promise<boolean> =>
    this.journalDatabase.forgetChat(
      forget.sessionId,
      async () =>
        (await stillWanted()) &&
        this.commitStoreCommand({
          kind: 'forget-idle',
          ...forget,
          legacyTabIds: this.transactions.legacySessionTabIds
        })
    )

  /** Deletes every session of a chat for good with their tabs and its tombstone, in one commit, or
   *  none: each must be at rest. The caller holds every session's conversation lane; each journal
   *  lane is held here after any conversion. */
  forgetChat = (forget: AgentSessionChatForget): Promise<boolean> => {
    const inJournalLanes = (ids: readonly string[]): Promise<boolean> => {
      const [first, ...rest] = ids
      return first === undefined
        ? this.commitChatForget(forget)
        : this.journalDatabase.forgetChat(first, () => inJournalLanes(rest))
    }
    return inJournalLanes(forget.sessionIds)
  }

  private async commitChatForget(forget: AgentSessionChatForget): Promise<boolean> {
    const forgotten = await this.commitStoreCommand({
      kind: 'forget-chat',
      ...forget,
      legacyTabIds: this.transactions.legacySessionTabIds
    })
    if (forgotten) {
      this.deletedChats.add({
        chatId: forget.chatId,
        sessionIds: [...forget.sessionIds],
        conversations: [...forget.conversations]
      })
    }
    return forgotten
  }
}
