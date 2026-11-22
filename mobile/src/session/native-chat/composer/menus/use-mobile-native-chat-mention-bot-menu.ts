// The bots part of the `@` list: their rows above the files, a bot's chats in place of both, and
// what picking either writes, as the desktop's `@` list does.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ComposerAutocomplete } from '../../../../../../src/shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { rankNativeChatRoomMembers } from '../../../../../../src/shared/native-chat/input/native-chat-room-mentions'
import {
  botMentionChatsMatching,
  botMentionToken
} from '../../../../../../src/shared/bots/bot-mention-context'
import { MENU_ROWS_PER_GROUP } from './mobile-native-chat-composer-menu'
import type { ComposerMenuRow, MentionBotRow } from './MobileNativeChatComposerMenu'
import type { MentionBot, MentionBots } from './use-mobile-native-chat-mention-bots'

type Drill = { botId: string; triggerKey: string; query: string }
type BotRow = Extract<ComposerMenuRow, { kind: 'bot' }>

export function useMobileNativeChatMentionBotMenu(
  bots: MentionBots | undefined,
  autocomplete: ComposerAutocomplete
) {
  const [drill, setDrill] = useState<Drill | null>(null)
  const mention = autocomplete.mode === 'mention' ? autocomplete : null
  const ensure = bots?.ensure
  const open = mention !== null
  useEffect(() => {
    if (open) {
      ensure?.()
    }
  }, [open, ensure])
  const drilled =
    mention && drill?.triggerKey === mention.triggerKey
      ? bots?.bots.find((bot) => bot.id === drill.botId)
      : undefined

  const query = mention?.query ?? null
  const rows = useMemo((): MentionBotRow[] => {
    if (!bots || query === null) {
      return []
    }
    if (drilled && drill) {
      // What was typed to find the bot stays; only what follows filters its chats.
      const filter = query.startsWith(drill.query) ? query.slice(drill.query.length) : query
      return [
        { kind: 'bot-back', id: 'bot-back', bot: drilled },
        ...chatRows(bots, drilled, filter)
      ]
    }
    const byId = new Map(bots.bots.map((bot) => [bot.id, bot]))
    const members = bots.bots.map((bot) => ({
      name: bot.name,
      key: bot.id,
      ...(bot.paused ? { unavailable: 'paused' } : {})
    }))
    return rankNativeChatRoomMembers(members, query)
      .matches.slice(0, MENU_ROWS_PER_GROUP)
      .flatMap((match) => {
        const bot = byId.get(match.value)
        return bot
          ? [{ kind: 'bot', id: `bot:${bot.id}`, bot, chats: bots.chatPicks && !bot.paused }]
          : []
      })
  }, [bots, query, drilled, drill])

  const openChats = (row: BotRow): void => {
    if (mention) {
      setDrill({ botId: row.bot.id, triggerKey: mention.triggerKey, query: mention.query })
      bots?.readChats(row.bot.id)
    }
  }

  /** What picking `row` writes in place of the `@` query; null when it writes nothing. */
  const pick = (row: MentionBotRow): string | null => {
    switch (row.kind) {
      case 'bot':
        if (row.bot.paused) {
          return null
        }
        // The chat's own bot alone is this chat: its row opens its other chats instead.
        if (row.bot.own) {
          openChats(row)
          return null
        }
        setDrill(null)
        return botMentionToken(row.bot)
      case 'bot-back':
        setDrill(null)
        return null
      case 'bot-chat':
        setDrill(null)
        // Another bot's Home Chat is the bot alone; the chat's own bot's is picked by id.
        return row.chat.home && !row.bot.own
          ? botMentionToken(row.bot)
          : botMentionToken(row.bot, row.chat.id)
      case 'bot-chats-state':
        if (row.state === 'error') {
          bots?.readChats(row.bot.id)
        }
        return null
    }
  }

  /** The `@` list: a bot's chats alone while they show, else the bots above the files. */
  const listed = useCallback(
    (filePaths: readonly string[]): ComposerMenuRow[] =>
      drilled
        ? rows
        : [
            ...rows,
            ...filePaths
              .slice(0, MENU_ROWS_PER_GROUP)
              .map((path) => ({ kind: 'file' as const, id: `file:${path}`, path }))
          ],
    [drilled, rows]
  )

  return { listed, openChats, pick }
}

function chatRows(bots: MentionBots, bot: MentionBot, filter: string): MentionBotRow[] {
  const read = bots.chats(bot.id)
  const state = (value: 'loading' | 'error' | 'none' | 'no-match'): MentionBotRow[] => [
    { kind: 'bot-chats-state', id: 'bot-chats-state', bot, state: value }
  ]
  if (!read || read.status === 'loading') {
    return state('loading')
  }
  if (read.status === 'error') {
    return state('error')
  }
  if (read.chats.length === 0) {
    return state('none')
  }
  const searchable = read.chats.map((chat) => ({
    chat,
    search: `${chat.title ?? ''}\n${chat.lastSaid ?? chat.lastAsked ?? ''}`
  }))
  const shown = botMentionChatsMatching(searchable, filter)
  return shown.length === 0
    ? state('no-match')
    : shown.map(({ chat }) => ({ kind: 'bot-chat', id: `bot-chat:${chat.id}`, bot, chat }))
}
