// A group's Items, read: each member's items and asks from its own reads, scoped to the group's rooms
// by the filter, merged into one set of groups as the desktop's group panel merges them.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  botItemStaleDays,
  botItemsClosedInTimeOrder,
  botItemsByDispatch,
  filterBotItems,
  groupBotsItems,
  isBotItemUnseen
} from '../../../src/shared/bots/bot-item-groups'
import { mergeBotItemsByUid } from '../../../src/shared/bots/bot-item-merge'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import { botGroupSessionIds, type BotGroup } from '../../../src/shared/bots/bot-group'
import { botGroupMemberBots } from '../../../src/shared/bots/bot-sidebar-entries'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupList } from './bot-group-operations'
import { botActivityRead, type SheetActivity } from './bot-sheet-operations'
import type { BotGroupItemReads } from './use-mobile-bot-group-transcript'
import type { PhoneBot } from './host-bots-operations'
import { usePhoneBotChatTree } from './use-phone-bot-chat-tree'
import { usePhoneNeedsYouAsks, type PhoneAsk } from './items/phone-needs-you-asks'
import { usePhoneBotItems, type PhoneBotItems } from './items/use-phone-bot-items'

type Translate = ReturnType<typeof useMobileTranslation>
export const GROUP_SCOPE = 'group'
const ALL_SCOPE = 'all'
export type BotGroupItemsScope = {
  key: string
  name: string
  kind: 'group' | 'room' | 'thread' | 'all'
  chatIds: string[] | null
}

function groupScopes(group: BotGroup, t: Translate): BotGroupItemsScope[] {
  const threads = group.threads ?? []
  return [
    {
      key: GROUP_SCOPE,
      name: t('bots.groups.items.thisGroup', 'This group'),
      kind: 'group',
      chatIds: botGroupSessionIds([group, ...threads])
    },
    // A group without threads has one room, which This group already is.
    ...(threads.length > 0
      ? [
          {
            key: group.id,
            name: group.name,
            kind: 'room' as const,
            chatIds: botGroupSessionIds([group])
          },
          ...threads.map((thread) => ({
            key: thread.id,
            name: thread.title ?? t('bots.groups.items.thread', 'Thread'),
            kind: 'thread' as const,
            chatIds: botGroupSessionIds([thread])
          }))
        ]
      : []),
    {
      key: ALL_SCOPE,
      name: t('bots.groups.items.all', 'All their work'),
      kind: 'all',
      chatIds: null
    }
  ]
}

/** A member's item read count: its own notices', and those naming every member. */
export function memberItemReads(reads: BotGroupItemReads, botId: string): number {
  return reads.all + (reads.bots[botId] ?? 0)
}

/** A member's ask read count: its item reads', and its chats' own. */
function memberAskReads(reads: BotGroupItemReads, botId: string): number {
  return memberItemReads(reads, botId) + reads.asks.all + (reads.asks.bots[botId] ?? 0)
}

function roomsOf(group: BotGroup): string {
  const { name, members, formerSessionIds, threads } = group
  return JSON.stringify({ name, members, formerSessionIds, threads })
}

/** A member's workers as its Activity reads them, for which of their asks are approvals. */
function useMemberWorkers(
  client: RpcClient | null,
  botId: string,
  showing: boolean,
  reads: number
): SheetActivity['workers'] | undefined {
  const [workers, setWorkers] = useState<SheetActivity['workers']>()
  useEffect(() => {
    if (!showing || !client) {
      return
    }
    let current = true
    botActivityRead
      .request(client, { botId })
      .then((reply) => {
        const answer = readHostMethodReply(reply, botActivityRead.interpret)
        // A failed read keeps the last one: its asks still list, as waits rather than approvals.
        if (current && answer.kind === 'answered') {
          setWorkers(answer.value.activity.workers)
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, botId, showing, reads])
  return workers
}

/** One member's items and asks, read as its own panel reads them; hooks can't run in a loop, so each
 *  member mounts one. Its asks are those of the filter's chats; an access request is no chat's, so only
 *  All their work could list it, and the phone reviews those from the bot's own panel. */
function MemberItemsReader({
  client,
  botId,
  chatIds,
  showing,
  reads,
  askReads,
  report
}: {
  client: RpcClient | null
  botId: string
  chatIds: readonly string[] | null
  showing: boolean
  reads: number
  askReads: number
  report: (botId: string, items: PhoneBotItems, asks: readonly PhoneAsk[]) => void
}) {
  const items = usePhoneBotItems({ client, botId, chatIds, showing, reads })
  const tree = usePhoneBotChatTree({ client, botId, showing, reads: askReads })
  const workers = useMemberWorkers(client, botId, showing, askReads)
  const chats = tree.kind === 'tree' ? tree.chats : null
  const allItems = items.read?.items
  const { asks: all } = usePhoneNeedsYouAsks({
    client: showing ? client : null,
    chats,
    workers,
    items: allItems,
    access: null,
    itemCount: 0
  })
  // As the desktop scopes them: a chat's ask by that chat, a worker's by its item's chat, else by
  // the chat it runs under.
  const asks = useMemo(() => {
    if (!chatIds) {
      return all
    }
    const byDispatch = botItemsByDispatch(allItems ?? [])
    const under = new Map(
      (chats ?? []).flatMap((chat) => chat.running.map((worker) => [worker.key, chat.chatId]))
    )
    return all.filter((ask) => {
      const open = ask.open
      const chatId = !open
        ? null
        : 'chat' in open
          ? open.chat.chatId
          : 'worker' in open
            ? ((open.worker.dispatchId
                ? byDispatch.get(open.worker.dispatchId)?.chat.id
                : undefined) ?? under.get(open.worker.key))
            : null
      return chatId != null && chatIds.includes(chatId)
    })
  }, [all, chatIds, chats, allItems])
  // Runs each render; the panel redraws only when a read itself changed.
  useEffect(() => report(botId, items, asks))
  return null
}

export function useMobileBotGroupItems({
  visible,
  client,
  groupId,
  bots,
  needsYou,
  reads,
  memberIds,
  now,
  t
}: {
  visible: boolean
  client: RpcClient | null
  groupId: string
  bots: readonly PhoneBot[]
  needsYou: Readonly<Record<string, number>>
  reads: BotGroupItemReads
  /** Set to the members read here, so a notice re-reads only theirs. */
  memberIds: RefObject<readonly string[]>
  now: number
  t: Translate
}) {
  // The whole group, with its original room's members: a thread's room read lists the thread's.
  const [group, setGroup] = useState<BotGroup | null>(null)
  const [groupError, setGroupError] = useState<string | null>(null)
  const [groupAttempt, setGroupAttempt] = useState(0)
  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let current = true
    void groupList
      .request(client, undefined)
      .then((reply) => {
        if (current) {
          const next = groupList.interpret(reply).groups.find((entry) => entry.id === groupId)
          // A new post changes only the group's preview; its rooms (and so every read's chats) stay.
          setGroup((last) =>
            last && next && roomsOf(last) === roomsOf(next) ? last : (next ?? null)
          )
          // A group the host no longer lists has nothing to load: say so with Retry, not a spinner.
          setGroupError(next ? null : '')
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setGroupError(String(error))
        }
      })
    return () => {
      current = false
    }
  }, [visible, client, groupId, reads.rooms, groupAttempt])

  const [scopeKey, setScopeKey] = useState(GROUP_SCOPE)
  const [pickedIds, setBotIds] = useState<readonly string[] | null>(null)
  const [needsYouOnly, setNeedsYouOnly] = useState(false)
  const scopes = useMemo(() => (group ? groupScopes(group, t) : []), [group, t])
  const scope = scopes.find((entry) => entry.key === scopeKey) ?? scopes[0]
  const members = useMemo(() => (group ? botGroupMemberBots(group, bots) : []), [group, bots])
  useEffect(() => {
    memberIds.current = members.map((bot) => bot.id)
  }, [memberIds, members])
  const picked = members.filter((bot) => pickedIds?.includes(bot.id))
  // Picked bots that left the group drop out; none left is every member, as the desktop's filter.
  const botIds =
    picked.length > 0 && picked.length < members.length ? picked.map((bot) => bot.id) : null
  const shownBots = botIds === null ? members : picked

  const memberReads = useRef(new Map<string, PhoneBotItems>())
  const memberAsks = useRef(new Map<string, readonly PhoneAsk[]>())
  const [version, setVersion] = useState(0)
  const report = useRef((botId: string, items: PhoneBotItems, asks: readonly PhoneAsk[]) => {
    const last = memberReads.current.get(botId)
    const lastAsks = memberAsks.current.get(botId)
    memberReads.current.set(botId, items)
    memberAsks.current.set(botId, asks)
    if (
      // Two empty lists are the same.
      (lastAsks !== asks && ((lastAsks?.length ?? 0) > 0 || asks.length > 0)) ||
      last?.read !== items.read ||
      last.error !== items.error ||
      // A page read again holds other rows at the same length; two empty lists are the same.
      (last.items !== items.items && (last.items.length > 0 || items.items.length > 0)) ||
      (last.loadMoreClosed === null) !== (items.loadMoreClosed === null)
    ) {
      setVersion((version) => version + 1)
    }
  }).current
  const readOf = (bot: PhoneBot) => memberReads.current.get(bot.id)

  const filterChats = scope?.chatIds ?? null
  const shownKey = shownBots.map((bot) => bot.id).join('\n')
  // Merged once per read or filter change: the room redraws this on every keystroke.
  const { shownReads, groups, ownerOf, asks } = useMemo(() => {
    const shownReads = shownBots.flatMap((bot) => {
      const items = memberReads.current.get(bot.id)
      return items?.read ? [{ bot, items, read: items.read }] : []
    })
    const perBot = shownReads.map(({ bot, items, read }) => ({
      items: filterBotItems(mergeBotItemsByUid(read.items, items.items), {
        chatIds: filterChats,
        botIds: null,
        needsYou: needsYouOnly
      }),
      staleDays: botItemStaleDays(bot.itemsStale),
      seenEventId: read.seenEventId,
      more: items.loadMoreClosed !== null
    }))
    const grouped = groupBotsItems(perBot, now)
    // Each member pages its own Closed, so only what time order has settled shows, as on the desktop.
    const groups = {
      ...grouped,
      closed: botItemsClosedInTimeOrder(
        perBot.map(({ items, more }) => ({
          closed: items.filter((item) => item.status === 'done' || item.status === 'canceled'),
          more
        }))
      )
    }
    const ownerOf = new Map(
      shownReads.flatMap(({ bot, items, read }) =>
        [...read.items, ...items.items].map((item) => [item.uid, bot] as const)
      )
    )
    // Keyed by member too: two bots' chats can share an ask's key.
    const asks = shownBots.flatMap((bot) =>
      (memberAsks.current.get(bot.id) ?? []).map((ask) => ({
        ask: { ...ask, key: `${bot.id}:${ask.key}` },
        bot
      }))
    )
    return { shownReads, groups, ownerOf, asks }
    // `version` stands for the member reads (a ref, so a report never loops), `shownKey` for the shown bots.
  }, [version, members, shownKey, filterChats, needsYouOnly, now])
  const isUnseen = (item: BotItem) => {
    const owner = ownerOf.get(item.uid)
    const seen = owner ? readOf(owner)?.read?.seenEventId : undefined
    return seen !== undefined && isBotItemUnseen(item, seen)
  }
  const needsYouShown = groups.needs_you.length
  // A group whose members were all deleted has nothing to read, and shows its empty list.
  const allRead = group !== null && shownReads.length === shownBots.length
  const failed =
    groupError !== null || shownBots.some((bot) => (readOf(bot)?.error ?? null) !== null)
  const outside =
    filterChats && allRead
      ? Math.max(
          0,
          shownBots.reduce((sum, bot) => sum + (needsYou[bot.id] ?? 0), 0) - needsYouShown
        )
      : 0
  const filterOn = scopeKey !== GROUP_SCOPE || botIds !== null || needsYouOnly
  const clearFilter = () => {
    setScopeKey(GROUP_SCOPE)
    setBotIds(null)
    setNeedsYouOnly(false)
  }
  const closedTotal = needsYouOnly
    ? groups.closed.length
    : shownReads.reduce(
        (sum, { read }) => sum + (read.counts.done ?? 0) + (read.counts.canceled ?? 0),
        0
      )
  const moreClosed = shownBots.flatMap((bot) => readOf(bot)?.loadMoreClosed ?? [])
  const retry = () => {
    setGroupAttempt((attempt) => attempt + 1)
    shownBots.forEach((bot) => readOf(bot)?.retry())
  }
  const openCount = (bot: PhoneBot) =>
    readOf(bot)?.read?.items.filter(
      (item) =>
        item.status !== 'done' &&
        item.status !== 'canceled' &&
        (filterChats === null || filterChats.includes(item.chat.id))
    ).length ?? 0
  const readers: ReactNode = members.map((bot) => (
    <MemberItemsReader
      key={bot.id}
      client={client}
      botId={bot.id}
      chatIds={filterChats}
      showing={visible}
      reads={memberItemReads(reads, bot.id)}
      askReads={memberAskReads(reads, bot.id)}
      report={report}
    />
  ))
  return {
    group,
    members,
    scopes,
    scope,
    setScopeKey,
    botIds,
    setBotIds,
    needsYouOnly,
    setNeedsYouOnly,
    groups,
    ownerOf,
    asks,
    isUnseen,
    allRead,
    failed,
    error:
      groupError ?? shownBots.map((bot) => readOf(bot)?.error).find((error) => error != null) ?? '',
    outside,
    filterOn,
    clearFilter,
    closedTotal,
    moreClosed,
    retry,
    openCount,
    readers
  }
}

export type MobileBotGroupItemsRead = ReturnType<typeof useMobileBotGroupItems>
