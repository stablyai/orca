import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import {
  botItemStaleDays,
  botItemsClosedInTimeOrder,
  filterBotItems,
  groupBotsItems,
  isBotItemUnseen
} from '../../../src/shared/bots/bot-item-groups'
import { mergeBotItemsByUid } from '../../../src/shared/bots/bot-item-merge'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import { botActivityRead, type SheetActivity } from '../bots/bot-sheet-operations'
import { usePhoneNeedsYouAsks, type PhoneAsk } from '../bots/items/phone-needs-you-asks'
import { usePhoneBotItems, type PhoneBotItems } from '../bots/items/use-phone-bot-items'
import { usePhoneBotChatTree, type PhoneBotChatTree } from '../bots/use-phone-bot-chat-tree'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { subscribeRuntimeClientEvents } from '../transport/runtime-client-event-subscription'
import type { RailBotTarget } from './rail-bot-targets'

type TargetItemsReport = {
  items: PhoneBotItems
  asks: readonly PhoneAsk[]
  tree: PhoneBotChatTree
}

function useTargetWorkers(
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

function TargetItemsReader({
  target,
  showing,
  reads,
  onReport,
  onForget
}: {
  target: RailBotTarget
  showing: boolean
  reads: number
  onReport: (key: string, report: TargetItemsReport) => void
  onForget: (key: string) => void
}): null {
  const targetKey = target.key
  useLayoutEffect(() => () => onForget(targetKey), [targetKey, onForget])
  const items = usePhoneBotItems({
    client: target.client,
    hostKey: target.hostKey,
    botId: target.bot.id,
    chatIds: null,
    showing,
    reads
  })
  const tree = usePhoneBotChatTree({
    client: target.client,
    botId: target.bot.id,
    showing,
    reads
  })
  const workers = useTargetWorkers(target.client, target.bot.id, showing, reads)
  const chats = tree.kind === 'tree' ? tree.chats : null
  const { asks } = usePhoneNeedsYouAsks({
    client: showing ? target.client : null,
    chats,
    workers,
    items: items.read?.items,
    access: null,
    itemCount: 0
  })
  useEffect(() => {
    onReport(targetKey, { items, asks, tree })
  }, [targetKey, items, asks, tree, onReport])
  return null
}

function reportChanged(previous: TargetItemsReport | undefined, next: TargetItemsReport): boolean {
  if (!previous) {
    return true
  }
  return (
    (previous.asks !== next.asks && (previous.asks.length > 0 || next.asks.length > 0)) ||
    previous.tree.currentReads !== next.tree.currentReads ||
    previous.tree.refreshFailed !== next.tree.refreshFailed ||
    previous.items.read !== next.items.read ||
    previous.items.error !== next.items.error ||
    previous.items.currentReads !== next.items.currentReads ||
    (previous.items.items !== next.items.items &&
      (previous.items.items.length > 0 || next.items.items.length > 0)) ||
    (previous.items.loadMoreClosed === null) !== (next.items.loadMoreClosed === null)
  )
}

/** Reads, filters, and groups items and asks across every bot target shown by the rail Items sheet. */
export function useRailBotItems({
  visible,
  targets,
  now
}: {
  visible: boolean
  targets: readonly RailBotTarget[]
  now: number
}) {
  const [pickedKeys, setPickedKeys] = useState<readonly string[] | null>(null)
  const [needsYouOnly, setNeedsYouOnly] = useState(false)
  const [reads, setReads] = useState(0)
  const [reports, setReports] = useState<ReadonlyMap<string, TargetItemsReport>>(() => new Map())

  useEffect(() => {
    if (visible) {
      setReads((count) => count + 1)
    }
  }, [visible])

  const uniqueClients = useMemo(() => {
    const seen = new Set<RpcClient>()
    const list: RpcClient[] = []
    for (const target of targets) {
      if (target.client && !seen.has(target.client)) {
        seen.add(target.client)
        list.push(target.client)
      }
    }
    return list
  }, [targets])

  useEffect(() => {
    if (!visible || uniqueClients.length === 0) {
      return
    }
    const unsubscribes = uniqueClients.map((client) =>
      subscribeRuntimeClientEvents(client, {
        onReady: (replayed) => {
          if (replayed) {
            setReads((count) => count + 1)
          }
        },
        onEvent: (event) => {
          if (event.type === 'botsChanged') {
            setReads((count) => count + 1)
          }
        }
      })
    )
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [visible, uniqueClients])

  const onReport = useCallback((key: string, next: TargetItemsReport) => {
    setReports((previous) => {
      if (!reportChanged(previous.get(key), next)) {
        return previous
      }
      const updated = new Map(previous)
      updated.set(key, next)
      return updated
    })
  }, [])

  const onForget = useCallback((key: string) => {
    setReports((previous) => {
      if (!previous.has(key)) {
        return previous
      }
      const updated = new Map(previous)
      updated.delete(key)
      return updated
    })
  }, [])

  const { effectivePickedKeys, shownTargets } = useMemo(() => {
    const picked = targets.filter((target) => pickedKeys?.includes(target.key))
    const keys =
      picked.length > 0 && picked.length < targets.length
        ? picked.map((target) => target.key)
        : null
    return { effectivePickedKeys: keys, shownTargets: keys === null ? targets : picked }
  }, [targets, pickedKeys])
  const showHostNames = useMemo(
    () => new Set(targets.map((target) => target.hostKey)).size > 1,
    [targets]
  )

  const { shownReads, groups, ownerOf, asks } = useMemo(() => {
    const shownReads = shownTargets.flatMap((target) => {
      const report = reports.get(target.key)
      return report?.items.read ? [{ target, items: report.items, read: report.items.read }] : []
    })
    const perBot = shownReads.map(({ target, items, read }) => ({
      items: filterBotItems(mergeBotItemsByUid(read.items, items.items), {
        chatIds: null,
        botIds: null,
        needsYou: needsYouOnly
      }),
      staleDays: botItemStaleDays(target.bot.itemsStale),
      seenEventId: read.seenEventId,
      more: items.loadMoreClosed !== null
    }))
    const grouped = groupBotsItems(perBot, now)
    const groups = {
      ...grouped,
      closed: botItemsClosedInTimeOrder(
        perBot.map(({ items, more }) => ({
          closed: items.filter((item) => item.status === 'done' || item.status === 'canceled'),
          more
        }))
      )
    }
    const ownerOf = new Map<string, RailBotTarget>(
      shownReads.flatMap(({ target, items, read }) =>
        [...read.items, ...items.items].map((item) => [item.uid, target] as const)
      )
    )
    const asks = shownTargets.flatMap((target) =>
      (reports.get(target.key)?.asks ?? []).map((ask) => ({
        ask: { ...ask, key: `${target.key}:${ask.key}` },
        target
      }))
    )
    return { shownReads, groups, ownerOf, asks }
  }, [shownTargets, reports, needsYouOnly, now])

  const isUnseen = (item: BotItem): boolean => {
    const owner = ownerOf.get(item.uid)
    const seen = owner ? reports.get(owner.key)?.items.read?.seenEventId : undefined
    return seen !== undefined && isBotItemUnseen(item, seen)
  }

  const allRead = shownTargets.length > 0 && shownReads.length === shownTargets.length
  const failed = shownTargets.some((target) => {
    const report = reports.get(target.key)
    return (report?.items.error ?? null) !== null || report?.tree.refreshFailed === true
  })
  const error =
    shownTargets.map((target) => reports.get(target.key)?.items.error).find((e) => e != null) ?? ''
  const filterOn = effectivePickedKeys !== null || needsYouOnly
  const clearFilter = () => {
    setPickedKeys(null)
    setNeedsYouOnly(false)
  }
  const closedTotal = needsYouOnly
    ? groups.closed.length
    : shownReads.reduce(
        (sum, { read }) => sum + (read.counts.done ?? 0) + (read.counts.canceled ?? 0),
        0
      )
  const moreClosed = shownTargets.flatMap(
    (target) => reports.get(target.key)?.items.loadMoreClosed ?? []
  )
  const retry = () => {
    shownTargets.forEach((target) => {
      const report = reports.get(target.key)
      report?.items.retry()
      report?.tree.retry()
    })
  }
  const openCount = (target: RailBotTarget): number =>
    reports
      .get(target.key)
      ?.items.read?.items.filter((item) => item.status !== 'done' && item.status !== 'canceled')
      .length ?? 0

  const readers: ReactNode = targets.map((target) => (
    <TargetItemsReader
      key={target.key}
      target={target}
      showing={visible}
      reads={reads}
      onReport={onReport}
      onForget={onForget}
    />
  ))

  return {
    reads,
    targets,
    shownTargets,
    pickedKeys: effectivePickedKeys,
    setPickedKeys,
    needsYouOnly,
    setNeedsYouOnly,
    showHostNames,
    groups,
    ownerOf,
    asks,
    isUnseen,
    allRead,
    failed,
    error,
    filterOn,
    clearFilter,
    closedTotal,
    moreClosed,
    retry,
    openCount,
    readers
  }
}
