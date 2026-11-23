// The host's deleted chats, in memory: loaded from their tombstones as the chat store opens, added
// to by each delete's commit. Their ids are never reused, their conversations never listed or adopted.

/** A provider conversation as Session History rows it: the chat's agent and the row's session id. */
export type DeletedChatConversation = { provider: string; providerSessionId: string }

export type DeletedChat = {
  /** The first session of the chat's /clear lineage. */
  chatId: string
  sessionIds: string[]
  conversations: DeletedChatConversation[]
}

const conversationKey = (conversation: DeletedChatConversation): string =>
  `${conversation.provider}\0${conversation.providerSessionId}`

/** The host's deleted chats, in memory: loaded with the store, added to by each delete's commit. */
export class DeletedChats {
  private readonly sessions = new Set<string>()
  private readonly conversations = new Set<string>()

  constructor(chats: readonly DeletedChat[] = []) {
    chats.forEach(this.add)
  }

  add = (chat: DeletedChat): void => {
    chat.sessionIds.forEach((id) => this.sessions.add(id))
    chat.conversations.forEach((conversation) =>
      this.conversations.add(conversationKey(conversation))
    )
  }

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)

  hasConversation = (conversation: DeletedChatConversation): boolean =>
    this.conversations.has(conversationKey(conversation))
}
