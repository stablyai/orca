// `@` in a chat lists the chat's host's bots, as the desktop's does, and one level down a bot's chats.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
  chats: (botId: string) => MentionBotChats | undefined
  readChats: (botId: string) => void
}

const NO_BOTS: readonly MentionBot[] = []

export function useMobileNativeChatMentionBots(enabled: boolean): MentionBots | undefined {
  const host = useMobileBotCardHost()
  const identity = useContext(MobileNativeChatBotIdentityContext)
  const listsBots = useRouteCapability(BOTS_MOBILE_RUNTIME_CAPABILITY) && enabled && host !== null
  const chatPicks = useRouteCapability(BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY)
  const listing = useHostBotsEntry(listsBots ? (host?.hostKey ?? null) : null)?.bots ?? null
  const [reads, setReads] = useState<ReadonlyMap<string, MentionBotChats>>(new Map())
  const latest = useRef(new Map<string, number>())
  const client = host?.client ?? null
  const hostKey = host?.hostKey ?? null
  const selfId = identity?.botId ?? null
  const callerSessionId = identity?.sessionId

  const bots = useMemo(() => {
    if (!listing) {
      return NO_BOTS
    }
    const listed = listing.map((bot): MentionBot => ({
      id: bot.id,
      name: bot.name,
      avatar: mobileBotAvatarSource(bot),
      paused: bot.paused,
      own: bot.id === selfId
    }))
    // The chat's own bot leads, for its other chats, only where chats can be picked.
    const own = listed.filter((bot) => bot.own && chatPicks)
    return [...own, ...listed.filter((bot) => !bot.own)]
  }, [listing, selfId, chatPicks])

  // `@` lists what the shared store holds; a chat opened before any screen read the host's bots reads them once.
  const listed = listing !== null
  useEffect(() => {
    if (listsBots && !listed && client && hostKey) {
      void readHostBots(client, hostKey)
    }
  }, [listsBots, listed, client, hostKey])

  const readChats = useCallback(
    (botId: string) => {
      if (!client) {
        return
      }
      // Only the latest read of a bot's chats lands; an older reply never replaces it.
      const asked = (latest.current.get(botId) ?? 0) + 1
      latest.current.set(botId, asked)
      const key = readKey(callerSessionId, botId)
      const settle = (read: MentionBotChats) => {
        if (latest.current.get(botId) === asked) {
          setReads((current) => new Map(current).set(key, read))
        }
      }
      // Rows already read stay while they are read again, so the list never blanks.
      if (reads.get(key)?.status !== 'ready') {
        settle({ status: 'loading' })
      }
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
    [client, callerSessionId, reads]
  )

  return useMemo(
    () =>
      listsBots
        ? {
            bots,
            chatPicks,
            chats: (botId: string) => reads.get(readKey(callerSessionId, botId)),
            readChats
          }
        : undefined,
    [listsBots, bots, chatPicks, reads, readChats, callerSessionId]
  )
}

// A chat read as another chat (the composer moved to it) marks that one as itself, so each is kept apart.
const readKey = (callerSessionId: string | undefined, botId: string) =>
  `${callerSessionId ?? ''}\n${botId}`

/** The chats a pick can name now, the Home Chat first, then the newest. */
function offeredChats(rows: readonly BotChatRow[]): BotChatRow[] {
  return rows
    .filter(botMentionOffersChat)
    .sort((a, b) => Number(b.home) - Number(a.home) || b.lastActivityAt - a.lastActivityAt)
}
