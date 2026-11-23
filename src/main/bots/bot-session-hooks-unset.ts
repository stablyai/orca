// What a runtime's bot sessions do before the runtime sets the real hooks: nothing.
import type { BotSessionHooks } from './bot-turn-ended'

export const UNSET_BOT_SESSION_HOOKS: BotSessionHooks = {
  turnEnded: () => {},
  requestFailed: () => {},
  groupRoomOf: () => null,
  recentChats: async () => null,
  unansweredQuestionNote: async () => null,
  chatsOf: async () => [],
  sendItemMail: async () => false
}
