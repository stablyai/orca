// Open its chat from a bot card: the named chat once the host has it ready, else the bot's Home. A newer
// tap, or the owner leaving this chat, supersedes an open still waiting on the host, Home's included.
import type { StructuredSessionOpenResult } from '../../../../../../src/shared/agent-session/view/open-structured-agent-session'

export type BotCardChatBot = { id: string; name: string; folderWorkspaceId: string }

export type BotCardChatOpener = {
  open: (bot: BotCardChatBot, chatId: string) => void
  /** Opens the bot's Home once its host has the Home chat ready. */
  home: (bot: BotCardChatBot) => void
  /** Drops any open still waiting, so it neither navigates nor falls back to Home. */
  cancel: () => void
}

export function botCardChatOpener(deps: {
  /** Readies the chat's tab on the host; stops early once `current` turns false. */
  ready: (
    bot: BotCardChatBot,
    chatId: string,
    current: () => boolean
  ) => Promise<StructuredSessionOpenResult>
  show: (bot: BotCardChatBot, chatId: string, opened: { worktreeId: string; tabId: string }) => void
  /** Stops short of navigating once `current` turns false. */
  home: (bot: BotCardChatBot, current: () => boolean) => void
}): BotCardChatOpener {
  let generation = 0
  const supersede = () => {
    const mine = ++generation
    return () => mine === generation
  }
  return {
    open: (bot, chatId) => {
      const current = supersede()
      const home = () => current() && deps.home(bot, current)
      void deps.ready(bot, chatId, current).then((opened) => {
        if (opened.kind !== 'opened') {
          home()
        } else if (current()) {
          deps.show(bot, chatId, { worktreeId: opened.target.worktreeId, tabId: opened.tab.id })
        }
      }, home)
    },
    home: (bot) => deps.home(bot, supersede()),
    cancel: () => {
      generation += 1
    }
  }
}
