// `@` in a chat lists the chat's host's bots, as the desktop's does, and one level down a bot's chats.
import { useCallback, useContext, useMemo, useState } from 'react'
import {
  BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY
} from '../../../../../../src/shared/bot-runtime-capabilities'
import type { BotChatRow } from '../../../../../../src/shared/bots/bot-chat-row'
import { botMentionOffersChat } from '../../../../../../src/shared/bots/bot-mention-context'
import { useHostBotsEntry } from '../../../../bots/host-bot-store'
import { botChatsRead } from '../../../../bots/host-bots-operations'
import { readHostBots } from '../../../../bots/host-bots-read'
import {
  mobileBotAvatarSource,
  type MobileBotAvatarSource
} from '../../../../bots/host-bot-row-facts'
import { readHostMethodReply } from '../../../../host-screen/sidebar-feed/host-sidebar-feed-operations'
import { useRouteCapability } from '../../../../worktree/execution-hosts/use-route-capability'
import { useMobileBotCardHost } from '../../transcript/bot-cards/mobile-bot-card-host'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'

export type MentionBot = {
  id: string
  name: string
  avatar: MobileBotAvatarSource
  paused: boolean
  /** The bot whose chat this is: its row lists its other chats. */
  own: boolean
}

export type MentionBotChats =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; chats: readonly BotChatRow[] }

export type MentionBots = {
  bots: readonly MentionBot[]
  /** The host takes a picked chat, so each bot's row offers its chats. */
  chatPicks: boolean
  /** Reads the host's bots once if no screen has yet. */
  ensure: () => void
  chats: (botId: string) => MentionBotChats | undefined
  readChats: (botId: string) => void
}

const NO_BOTS: readonly MentionBot[] = []

export function useMobileNativeChatMentionBots(enabled: boolean): MentionBots | undefined {
  const host = useMobileBotCardHost()
  const identity = useContext(MobileNativeChatBotIdentityContext)
  const listsBots = useRouteCapability(BOTS_MOBILE_RUNTIME_CAPABILITY) && enabled && host !== null
  const chatPicks = useRouteCapability(BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY)
  const entry = useHostBotsEntry(listsBots ? (host?.hostKey ?? null) : null)
  const [reads, setReads] = useState<ReadonlyMap<string, MentionBotChats>>(new Map())
  const client = host?.client ?? null
  const hostKey = host?.hostKey ?? null
  const selfId = identity?.botId ?? null
  const callerSessionId = identity?.sessionId

  const bots = useMemo(() => {
    if (!entry) {
      return NO_BOTS
    }
    const listed = entry.bots.map((bot): MentionBot => ({
      id: bot.id,
      name: bot.name,
      avatar: mobileBotAvatarSource(bot),
      paused: bot.paused,
      own: bot.id === selfId
    }))
    // The chat's own bot leads, for its other chats, only where chats can be picked.
    const own = listed.filter((bot) => bot.own && chatPicks)
    return [...own, ...listed.filter((bot) => !bot.own)]
  }, [entry, selfId, chatPicks])

  const ensure = useCallback(() => {
    if (listsBots && !entry && client && hostKey) {
      void readHostBots(client, hostKey)
    }
  }, [listsBots, entry, client, hostKey])

  const readChats = useCallback(
    (botId: string) => {
      if (!client) {
        return
      }
      const settle = (read: MentionBotChats) =>
        setReads((current) => new Map(current).set(botId, read))
      settle({ status: 'loading' })
      void botChatsRead
        .request(client, { botId, ...(callerSessionId ? { callerSessionId } : {}) })
        .then((reply) => {
          const read = readHostMethodReply(reply, botChatsRead.interpret)
          settle(
            read.kind === 'answered'
              ? { status: 'ready', chats: offeredChats(read.value.chats) }
              : { status: 'error' }
          )
        })
        .catch(() => settle({ status: 'error' }))
    },
    [client, callerSessionId]
  )

  return useMemo(
    () =>
      listsBots
        ? { bots, chatPicks, ensure, chats: (botId: string) => reads.get(botId), readChats }
        : undefined,
    [listsBots, bots, chatPicks, ensure, reads, readChats]
  )
}

/** The chats a pick can name now, the Home Chat first, then the newest. */
function offeredChats(rows: readonly BotChatRow[]): BotChatRow[] {
  return rows
    .filter(botMentionOffersChat)
    .sort((a, b) => Number(b.home) - Number(a.home) || b.lastActivityAt - a.lastActivityAt)
}
