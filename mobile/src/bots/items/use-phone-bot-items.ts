// A bot's items as the panel's Items tab shows them: every open one, closed ones a page at a time, read
// again with the route's other reads (botsChanged, reconnect, foreground). A failed re-read keeps the
// last good read up. One chat's items, while the filter shows it, come from their own read.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotItemsListRead } from '../../../../src/shared/bots/bot-item-schema'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { readBotItems } from './bot-item-operations'

export type PhoneBotItems = {
  /** The last good read, with any Closed pages read past it; null until one lands. */
  read: BotItemsListRead | null
  /** Closed items read past the first page. */
  items: BotItem[]
  /** The latest read failed: `read` is the last good one, or null if none landed. */
  failed: boolean
  retry: () => void
  /** Reads the next Closed page; null when there is none. */
  loadMoreClosed: (() => Promise<void>) | null
}

type Shown = { key: string; read: BotItemsListRead; failed: boolean }
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
  botId,
  chatId,
  showing,
  reads
}: {
  client: RpcClient | null
  botId: string
  /** One chat's items (the filter); null for all. */
  chatId: string | null
  showing: boolean
  /** The route's item read count (`itemReads`): each items or workers notice, reconnect or foreground. */
  reads: number
}): PhoneBotItems {
  const key = `${botId}\n${chatId ?? ''}`
  const [shown, setShown] = useState<Shown | null>(null)
  const [failedFirst, setFailedFirst] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pages, setPages] = useState<Pages | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!showing || !client) {
      return
    }
    let current = true
    void readBotItems(client, botId, chatId !== null ? { chatId } : {}).then((answer) => {
      if (!current) {
        return
      }
      if (answer.kind === 'read') {
        setShown({ key, read: answer.value, failed: false })
        setFailedFirst(null)
      } else {
        setShown((last) => (last?.key === key ? { ...last, failed: true } : last))
        setFailedFirst(key)
      }
    })
    return () => {
      current = false
    }
  }, [client, botId, chatId, key, showing, reads, attempt])

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
    void readClosedPages(client, botId, chatId, read.nextClosedCursor ?? null, depth).then(
      (next) => {
        if (generation.current === mine) {
          setPages(next ? { key, base: read, depth, ...next } : null)
        }
      }
    )
  }, [client, read, depth, upToDate, botId, chatId, key])

  const cursor = upToDate ? ownPages.cursor : depth === 0 ? (read?.nextClosedCursor ?? null) : null
  const loadMoreClosed = useCallback(async () => {
    if (!client || !read || !cursor) {
      return
    }
    const mine = ++generation.current
    const next = await readClosedPages(client, botId, chatId, cursor, 1)
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
  }, [client, read, cursor, botId, chatId, key])

  return {
    read,
    // While the depth is read again, the old rows stay up.
    items: ownPages?.items ?? [],
    failed: shown?.key === key ? shown.failed : failedFirst === key,
    retry: () => setAttempt((value) => value + 1),
    loadMoreClosed: cursor ? loadMoreClosed : null
  }
}

/** Up to `depth` Closed pages from `cursor`; null if a read fails. */
async function readClosedPages(
  client: RpcClient,
  botId: string,
  chatId: string | null,
  cursor: string | null,
  depth: number
): Promise<{ items: BotItem[]; cursor: string | null } | null> {
  const items: BotItem[] = []
  let next = cursor
  for (let page = 0; page < depth && next; page++) {
    const answer = await readBotItems(client, botId, {
      closedCursor: next,
      ...(chatId !== null ? { chatId } : {})
    })
    if (answer.kind !== 'read') {
      return null
    }
    items.push(
      ...answer.value.items.filter((item) => item.status === 'done' || item.status === 'canceled')
    )
    next = answer.value.nextClosedCursor ?? null
  }
  return { items, cursor: next }
}
