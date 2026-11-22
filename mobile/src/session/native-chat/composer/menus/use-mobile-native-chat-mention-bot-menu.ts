// The bots part of the `@` list: their rows above the files, a bot's chats in place of both, and
// what picking either writes, as the desktop's `@` list does.
import { useCallback, useMemo, useState } from 'react'
import type { ComposerAutocomplete } from '../../../../../../src/shared/native-chat/input/composer/native-chat-composer-autocomplete'
import {
  nativeChatRoomNameMatches,
  rankNativeChatRoomMembers
} from '../../../../../../src/shared/native-chat/input/native-chat-room-mentions'
import {
  botMentionChatsMatching,
  botMentionToken
} from '../../../../../../src/shared/bots/bot-mention-context'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MENU_ROWS_PER_GROUP } from './mobile-native-chat-composer-menu'
import type { ComposerMenuRow, MentionBotRow } from './MobileNativeChatComposerMenu'
import type { MentionBot, MentionBots } from './use-mobile-native-chat-mention-bots'

/** A bot's chats open under the `@` typed at `triggerKey`, found by `query`. */
type Drill = { botId: string; triggerKey: string; query: string }
type BotRow = Extract<ComposerMenuRow, { kind: 'bot' }>
type Mention = Extract<ComposerAutocomplete, { mode: 'mention' }>

export function useMobileNativeChatMentionBotMenu(bots: MentionBots | undefined) {
  const t = useMobileTranslation()
  const [drill, setDrill] = useState<Drill | null>(null)
  const members = useMemo(
    () =>
      bots?.bots.map((bot) => ({
        name: bot.name,
        key: bot.id,
        ...(bot.paused ? { unavailable: 'paused' } : {})
      })) ?? [],
    [bots]
  )
  /** A spaced `@` query stays open while it names a bot, or filters the open bot's chats. */
  const nameMatches = useMemo(
    () =>
      bots
        ? (query: string) =>
            drill ? query.startsWith(drill.query) : nativeChatRoomNameMatches(members, query)
        : undefined,
    [bots, drill, members]
  )

  /** The `@` list: a bot's chats alone while they show, else the bots above the files. */
  const listed = useCallback(
    (mention: Mention, filePaths: readonly string[]): ComposerMenuRow[] => {
      const files = filePaths
        .slice(0, MENU_ROWS_PER_GROUP)
        .map((path) => ({ kind: 'file' as const, id: `file:${path}`, path }))
      if (!bots) {
        return files
      }
      const open = openBot(bots, drill, mention)
      if (open && drill) {
        // What was typed to find the bot stays; only what follows filters its chats.
        return [
          { kind: 'bot-back', id: 'bot-back', bot: open },
          ...chatRows(bots, open, mention.query.slice(drill.query.length), t)
        ]
      }
      const byId = new Map(bots.bots.map((bot) => [bot.id, bot]))
      const botRows = rankNativeChatRoomMembers(members, mention.query)
        .matches.slice(0, MENU_ROWS_PER_GROUP)
        .flatMap((match): MentionBotRow[] => {
          const bot = byId.get(match.value)
          return bot
            ? [{ kind: 'bot', id: `bot:${bot.id}`, bot, chats: bots.chatPicks && !bot.paused }]
            : []
        })
      return [...botRows, ...files]
    },
    [bots, drill, members, t]
  )

  const openChats = (row: BotRow, mention: Mention | null): void => {
    if (mention) {
      setDrill({ botId: row.bot.id, triggerKey: mention.triggerKey, query: mention.query })
      bots?.readChats(row.bot.id)
    }
  }

  /** What picking `row` writes in place of the `@` query; null when it writes nothing. */
  const pick = (row: MentionBotRow, mention: Mention | null): string | null => {
    switch (row.kind) {
      case 'bot':
        if (row.bot.paused) {
          return null
        }
        // The chat's own bot alone is this chat: its row opens its other chats instead.
        if (row.bot.own) {
          openChats(row, mention)
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

  /** Called while rendering: once its `@` is gone, the bot's chats close, so a later `@` starts at
   *  the bots. */
  const follow = (mention: Mention | null): void => {
    if (drill && (!mention || !bots || !openBot(bots, drill, mention))) {
      setDrill(null)
    }
  }

  return { nameMatches, listed, openChats, pick, follow }
}

function openBot(bots: MentionBots, drill: Drill | null, mention: Mention): MentionBot | undefined {
  return drill?.triggerKey === mention.triggerKey && mention.query.startsWith(drill.query)
    ? bots.bots.find((bot) => bot.id === drill.botId)
    : undefined
}

function chatRows(
  bots: MentionBots,
  bot: MentionBot,
  filter: string,
  t: Translate
): MentionBotRow[] {
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
  // Searched by the title its row shows, as the desktop's list is.
  const searchable = read.chats.map((chat) => {
    const title = chat.home
      ? t('bots.chats.home', 'Home Chat')
      : chat.title || t('bots.chats.untitled', 'New chat')
    return { chat, search: `${title}\n${chat.lastSaid ?? chat.lastAsked ?? ''}` }
  })
  const shown = botMentionChatsMatching(searchable, filter).slice(0, MENU_ROWS_PER_GROUP)
  return shown.length === 0
    ? state('no-match')
    : shown.map(({ chat }) => ({ kind: 'bot-chat', id: `bot-chat:${chat.id}`, bot, chat }))
}
