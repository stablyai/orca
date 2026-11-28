// A bot's items as the panel's Items tab shows them: every open one, closed ones a page at a time, read
// again with the route's other reads (botsChanged, reconnect, foreground). A failed re-read keeps the
// last good read up. A group can request only its rooms’ items.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotItemsListRead } from '../../../../src/shared/bots/bot-item-schema'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  botItemAskCardDraftsClock,
  retireClosedBotItemAskCardDrafts
} from './bot-item-ask-card-drafts'
import { readBotItems } from './bot-item-operations'

export type PhoneBotItems = {
  /** The last good read, with any Closed pages read past it; null until one lands. */
  read: BotItemsListRead | null
  /** Closed items read past the first page. */
  items: BotItem[]
  /** Null while the latest read landed; why it failed otherwise (empty when nothing said why), with
   *  `read` the last good one, or null if none landed. */
  error: string | null
  retry: () => void
  /** The notice generation of the last successful read, null while stale or retrying. */
  currentReads: number | null
  /** Reads the next Closed page, and says what it held and whether more follow; null when there is none. */
  loadMoreClosed: (() => Promise<{ items: BotItem[]; more: boolean }>) | null
  /** The host has no Closed page past the ones read; false while they are read again. */
  closedEnded: boolean
}

type Shown = {
  key: string
  read: BotItemsListRead
  error: string | null
  reads: number
  attempt: number
  client: RpcClient
}
type Pages = {
  key: string
  /** The list read these pages continue. */
  base: BotItemsListRead
  depth: number
  items: BotItem[]
  cursor: string | null
}

export function usePhoneBotItems({
  client,
  hostKey,
  botId,
  chatIds,
  showing,
  reads
}: {
  client: RpcClient | null
  /** The phone's key for the bot's host (`hostBotsKey`): a read's closed items drop their kept
   *  answer cards. */
  hostKey: string
  botId: string
  /** These chats' items (the filter); null for all. */
  chatIds: readonly string[] | null
  showing: boolean
  /** The route's item read count (`itemReads`): each items or workers notice, reconnect or foreground. */
  reads: number
}): PhoneBotItems {
  const key = `${botId}\n${chatIds?.join('\n') ?? '*'}`
  const [shown, setShown] = useState<Shown | null>(null)
  const [failedFirst, setFailedFirst] = useState<{ key: string; error: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pages, setPages] = useState<Pages | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!showing || !client) {
      return
    }
    let current = true
    const askedAt = botItemAskCardDraftsClock()
    void readBotItems(client, botId, { chatIds }).then((answer) => {
      if (answer.kind === 'read') {
        // Whether shown or not, the host said these items closed.
        retireClosedBotItemAskCardDrafts(hostKey, botId, answer.value.items, askedAt)
      }
      if (!current) {
        return
      }
      if (answer.kind === 'read') {
        setShown({ key, read: answer.value, error: null, reads, attempt, client })
        setFailedFirst(null)
      } else {
        const error = answer.message ?? ''
        setShown((last) => (last?.key === key ? { ...last, error } : last))
        setFailedFirst({ key, error })
      }
    })
    return () => {
      current = false
    }
  }, [client, hostKey, botId, chatIds, key, showing, reads, attempt])

  const read = shown?.key === key ? shown.read : null
  const ownPages = pages?.key === key ? pages : null
  const depth = ownPages?.depth ?? 0
  const upToDate = ownPages !== null && ownPages.base === read
  // A newer list moves where its first page ends, so the loaded depth is read again from the new end:
  // no closed item is stranded between a stale page and a spent cursor (as the desktop does).
  useEffect(() => {
    if (!client || !read || depth === 0 || upToDate) {
      return
    }
    const mine = ++generation.current
    void readClosedPages(
      client,
      hostKey,
      botId,
      chatIds,
      read.nextClosedCursor ?? null,
      depth
    ).then((next) => {
      if (generation.current === mine) {
        setPages(next ? { key, base: read, depth, ...next } : null)
      }
    })
  }, [client, read, depth, upToDate, hostKey, botId, chatIds, key])

  const cursor = upToDate ? ownPages.cursor : depth === 0 ? (read?.nextClosedCursor ?? null) : null
  const loadMoreClosed = useCallback(async () => {
    if (!client || !read || !cursor) {
      return { items: [], more: false }
    }
    const mine = ++generation.current
    const next = await readClosedPages(client, hostKey, botId, chatIds, cursor, 1)
    if (!next) {
      throw new Error('read_failed')
    }
    if (generation.current === mine) {
      setPages((prev) => {
        const kept = prev?.key === key && prev.base === read ? prev : null
        return {
          key,
          base: read,
          depth: (kept?.depth ?? 0) + 1,
          items: [...(kept?.items ?? []), ...next.items],
          cursor: next.cursor
        }
      })
    }
    return { items: next.items, more: next.cursor !== null }
  }, [client, read, cursor, hostKey, botId, chatIds, key])

  return {
    read,
    // While the depth is read again, the old rows stay up.
    items: ownPages?.items ?? [],
    error: shown?.key === key ? shown.error : failedFirst?.key === key ? failedFirst.error : null,
    retry: () => setAttempt((value) => value + 1),
    currentReads:
      shown?.key === key &&
      shown.client === client &&
      shown.error === null &&
      shown.attempt === attempt
        ? shown.reads
        : null,
    loadMoreClosed: cursor ? loadMoreClosed : null,
    closedEnded: read !== null && cursor === null && (depth === 0 || upToDate)
  }
}

/** Up to `depth` Closed pages from `cursor`, each dropping its items' kept answer cards; null if a
 *  read fails. */
async function readClosedPages(
  client: RpcClient,
  hostKey: string,
  botId: string,
  chatIds: readonly string[] | null,
  cursor: string | null,
  depth: number
): Promise<{ items: BotItem[]; cursor: string | null } | null> {
  const items: BotItem[] = []
  let next = cursor
  for (let page = 0; page < depth && next; page++) {
    const askedAt = botItemAskCardDraftsClock()
    const answer = await readBotItems(client, botId, {
      closedCursor: next,
      closedOnly: true,
      chatIds
    })
    if (answer.kind !== 'read') {
      return null
    }
    retireClosedBotItemAskCardDrafts(hostKey, botId, answer.value.items, askedAt)
    items.push(
      ...answer.value.items.filter((item) => item.status === 'done' || item.status === 'canceled')
    )
    next = answer.value.nextClosedCursor ?? null
  }
  return { items, cursor: next }
}
