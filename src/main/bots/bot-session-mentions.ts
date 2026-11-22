import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import {
  botMentionContext,
  botMentionTokens,
  mentionedBots,
  mentionedServerBots,
  type BotMentionChat
} from '../../shared/bots/bot-mention-context'
import { soulSpecialty } from '../../shared/bot-roster'
import { botHomeFolder, localBotHomeFilesystem } from './bot-home'
import { messageWords } from '../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import type { KnownPairedBotRoster } from './paired-bot-rosters'

/** A picked chat as the host's own list has it: `--chat` only for one of the bot's chats that takes
 *  mail; any doubt (an unread list included) says it can't, and never falls back to the Home Chat. */
function checkedChat(rows: readonly BotChatRow[] | null, chatId: string): BotMentionChat {
  if (!rows) {
    return { refused: 'unverifiable' }
  }
  const row = rows.find((entry) => entry.id === chatId)
  if (!row) {
    return { refused: 'not-its-chat' }
  }
  if (row.self) {
    return { refused: 'self' }
  }
  return row.closed ? { refused: row.reason ?? 'unverifiable' } : { id: row.id, title: row.title }
}

export function createBotSessionMentions(deps: {
  botById: (botId: string) => Bot | undefined
  botChats?: (bot: Bot, sessionId: string) => Promise<readonly BotChatRow[]>
  pairedBotRosters?: (servers: ReadonlySet<string>) => Promise<readonly KnownPairedBotRoster[]>
}): (sessionId: string, message: AgentJournalMessageItem) => Promise<string | null> {
  const serverBotLines = async (words: string) => {
    const picks = mentionedServerBots(words)
    if (picks.length === 0 || !deps.pairedBotRosters) {
      return []
    }
    const rosters = await deps
      .pairedBotRosters(new Set(picks.map((pick) => pick.server)))
      .catch(() => [])
    return picks.flatMap((pick) => {
      const roster = rosters.find((entry) => entry.environmentId === pick.server)
      if (!roster) {
        return []
      }
      const listed = roster.bots?.find((bot) => bot.id === pick.id)
      if (roster.bots && !listed) {
        return []
      }
      return [
        {
          id: pick.id,
          name: listed?.name ?? pick.name,
          purpose: listed?.specialty ?? null,
          server: roster.server
        }
      ]
    })
  }

  return async (sessionId, message) => {
    const words = messageWords(message)
    const tokens = botMentionTokens(words)
    const localBots = tokens.some((token) => !token.server && !token.client)
      ? tokens.flatMap((token) => {
          if (token.server || token.client) {
            return []
          }
          const bot = deps.botById(token.id)
          return bot ? [bot] : []
        })
      : []
    const named = localBots.length > 0 ? mentionedBots(words, localBots) : []
    const remote = serverBotLines(words)
    const chatsOf = new Map<string, Promise<readonly BotChatRow[] | null>>()
    const readChats = (bot: Bot) => {
      let read = chatsOf.get(bot.id)
      if (!read) {
        read = (deps.botChats?.(bot, sessionId) ?? Promise.resolve(null)).catch(() => null)
        chatsOf.set(bot.id, read)
      }
      return read
    }
    return botMentionContext([
      ...(await Promise.all(
        named.map(async ({ bot, chatId }) => {
          const [soul, chat] = await Promise.all([
            localBotHomeFilesystem.readText(join(botHomeFolder(bot), 'SOUL.md')),
            chatId === null ? undefined : readChats(bot).then((rows) => checkedChat(rows, chatId))
          ])
          return {
            id: bot.id,
            name: bot.name,
            purpose: soulSpecialty(soul),
            ...(chat ? { chat } : {})
          }
        })
      )),
      ...(await remote)
    ])
  }
}
