import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import {
  botItemStaleDays,
  botItemsClosedInTimeOrder,
  filterBotItems,
  groupBotsItems,
  isBotItemUnseen
} from '../../../src/shared/bots/bot-item-groups'
import { mergeBotItemsByUid } from '../../../src/shared/bots/bot-item-merge'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { botGroupMemberBots } from '../../../src/shared/bots/bot-sidebar-entries'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupList } from './bot-group-operations'
import { botActivityRead, type SheetActivity } from './bot-sheet-operations'
import type { BotGroupItemReads } from './use-mobile-bot-group-transcript'
import type { PhoneBot } from './host-bots-operations'
import { usePhoneBotChatTree, type PhoneBotChatTree } from './use-phone-bot-chat-tree'
import { usePhoneNeedsYouAsks, type PhoneAsk } from './items/phone-needs-you-asks'
import { usePhoneBotItems, type PhoneBotItems } from './items/use-phone-bot-items'
import { groupItemsFresh, memberItemReads } from './phone-group-items-freshness'
import { recomputeOn } from '../hooks/recompute-on'
export { memberItemReads } from './phone-group-items-freshness'

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

function MemberItemsReader({
  client,
  hostKey,
  botId,
  showing,
  reads,
  askReads,
  report,
  forget
}: {
  client: RpcClient | null
  hostKey: string
  botId: string
  showing: boolean
  reads: number
  askReads: number
  forget: (botId: string) => void
  report: (
    botId: string,
    items: PhoneBotItems,
    asks: readonly PhoneAsk[],
    tree: PhoneBotChatTree
  ) => void
}) {
  useLayoutEffect(() => () => forget(botId), [botId, forget])
  const items = usePhoneBotItems({ client, hostKey, botId, chatIds: null, showing, reads })
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
  // Runs each render; the panel redraws only when a read itself changed.
  useEffect(() => report(botId, items, all, tree))
  return null
}

export function useMobileBotGroupItems({
  visible,
  client,
  hostKey,
  groupId,
  bots,
  reads,
  memberIds,
  now
}: {
  visible: boolean
  client: RpcClient | null
  /** The phone's key for the group's host (`hostBotsKey`). */
  hostKey: string
  groupId: string
  bots: readonly PhoneBot[]
  reads: BotGroupItemReads
  /** Set to the members read here, so a notice re-reads only theirs. */
  memberIds: RefObject<readonly string[]>
  now: number
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

  const [pickedIds, setBotIds] = useState<readonly string[] | null>(null)
  const [needsYouOnly, setNeedsYouOnly] = useState(false)
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
  const memberTrees = useRef(new Map<string, PhoneBotChatTree>())
  const [version, setVersion] = useState(0)
  const forget = useRef((botId: string) => {
    memberReads.current.delete(botId)
    memberAsks.current.delete(botId)
    memberTrees.current.delete(botId)
  }).current
  const report = useRef(
    (botId: string, items: PhoneBotItems, asks: readonly PhoneAsk[], tree: PhoneBotChatTree) => {
      const last = memberReads.current.get(botId)
      const lastAsks = memberAsks.current.get(botId)
      const lastTree = memberTrees.current.get(botId)
      memberReads.current.set(botId, items)
      memberAsks.current.set(botId, asks)
      memberTrees.current.set(botId, tree)
      if (
        // Two empty lists are the same.
        (lastAsks !== asks && ((lastAsks?.length ?? 0) > 0 || asks.length > 0)) ||
        lastTree?.currentReads !== tree.currentReads ||
        lastTree?.refreshFailed !== tree.refreshFailed ||
        last?.read !== items.read ||
        last.error !== items.error ||
        last.currentReads !== items.currentReads ||
        // A page read again holds other rows at the same length; two empty lists are the same.
        (last.items !== items.items && (last.items.length > 0 || items.items.length > 0)) ||
        (last.loadMoreClosed === null) !== (items.loadMoreClosed === null)
      ) {
        setVersion((version) => version + 1)
      }
    }
  ).current
  const readOf = (bot: PhoneBot) => memberReads.current.get(bot.id)

  const shownKey = shownBots.map((bot) => bot.id).join('\n')
  // Merged once per read or filter change: the room redraws this on every keystroke.
  const { shownReads, groups, ownerOf, asks } = useMemo(
    () =>
      recomputeOn([version, members, shownKey], () => {
        const shownReads = shownBots.flatMap((bot) => {
          const items = memberReads.current.get(bot.id)
          return items?.read ? [{ bot, items, read: items.read }] : []
        })
        const perBot = shownReads.map(({ bot, items, read }) => ({
          items: filterBotItems(mergeBotItemsByUid(read.items, items.items), {
            chatIds: null,
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
      }),
    [version, members, shownKey, needsYouOnly, now]
  )
  const isUnseen = (item: BotItem) => {
    const owner = ownerOf.get(item.uid)
    const seen = owner ? readOf(owner)?.read?.seenEventId : undefined
    return seen !== undefined && isBotItemUnseen(item, seen)
  }
  const allRead = group !== null && shownReads.length === shownBots.length
  const failed =
    groupError !== null ||
    shownBots.some(
      (bot) =>
        (readOf(bot)?.error ?? null) !== null ||
        memberTrees.current.get(bot.id)?.refreshFailed === true
    )
  const fresh =
    !failed &&
    groupItemsFresh(shownBots, reads, memberReads.current) &&
    shownBots.every(
      (bot) => memberTrees.current.get(bot.id)?.currentReads === memberAskReads(reads, bot.id)
    )
  const filterOn = botIds !== null || needsYouOnly
  const clearFilter = () => {
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
    shownBots.forEach((bot) => {
      readOf(bot)?.retry()
      memberTrees.current.get(bot.id)?.retry()
    })
  }
  const openCount = (bot: PhoneBot) =>
    readOf(bot)?.read?.items.filter((item) => item.status !== 'done' && item.status !== 'canceled')
      .length ?? 0
  const readers: ReactNode = members.map((bot) => (
    <MemberItemsReader
      key={bot.id}
      client={client}
      hostKey={hostKey}
      botId={bot.id}
      showing={visible}
      reads={memberItemReads(reads, bot.id)}
      askReads={memberAskReads(reads, bot.id)}
      report={report}
      forget={forget}
    />
  ))
  return {
    group,
    members,
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
    fresh,
    error:
      groupError ?? shownBots.map((bot) => readOf(bot)?.error).find((error) => error != null) ?? '',
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
