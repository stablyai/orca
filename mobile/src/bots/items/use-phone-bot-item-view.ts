// One item as its page shows it, read by uid (so any item opens, however old): the item, its newest
// Activity page with older pages on demand, and each change after appended, never re-read whole. Re-read
// with the route's other reads.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { mergeBotItemEvents } from '../../../../src/shared/bots/bot-item-merge'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { readBotItem } from './bot-item-operations'

export type PhoneBotItemView = {
  item: BotItem | null
  events: BotItemEvent[]
  hasEarlier: boolean
  /** The latest read failed; `item` is the last good read, if any. */
  failed: boolean
  /** The host doesn't have this item. */
  notFound: boolean
  loadEarlier: () => void
  retry: () => void
}

type Loaded = { uid: string; item: BotItem; events: BotItemEvent[]; earlierCursor: string | null }

export function usePhoneBotItemView({
  client,
  uid,
  reads
}: {
  client: RpcClient | null
  uid: string
  reads: number
}): PhoneBotItemView {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ uid: string; notFound: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = useRef<Loaded | null>(null)
  useLayoutEffect(() => {
    current.current = loaded?.uid === uid ? loaded : null
  }, [loaded, uid])

  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void (async () => {
      const known = current.current
      if (!known) {
        const page = await readBotItem(client, uid, { newest: true })
        if (!live) {
          return
        }
        if (page.kind === 'read') {
          setLoaded({
            uid,
            item: page.value.item,
            events: page.value.events,
            earlierCursor: page.value.earlierCursor ?? null
          })
          setFailure(null)
        } else {
          setFailure({ uid, notFound: page.notFound })
        }
        return
      }
      // Changes since: only the events after the newest one shown.
      let after = known.events.at(-1)?.id
      let item = known.item
      const added: BotItemEvent[] = []
      for (;;) {
        const page = await readBotItem(client, uid, after ? { after } : { newest: true })
        if (page.kind !== 'read') {
          if (live) {
            setFailure({ uid, notFound: page.notFound })
          }
          return
        }
        item = page.value.item
        added.push(...page.value.events.filter((event) => event.id !== after))
        if (!page.value.nextCursor || !after) {
          break
        }
        after = page.value.nextCursor
      }
      if (live) {
        setLoaded((prev) =>
          prev?.uid === uid
            ? { ...prev, item, events: mergeBotItemEvents(prev.events, added) }
            : prev
        )
        setFailure(null)
      }
    })()
    return () => {
      live = false
    }
  }, [client, uid, reads, attempt])

  const loadEarlier = useCallback(() => {
    const before = current.current?.earlierCursor
    if (!client || !before) {
      return
    }
    void readBotItem(client, uid, { newest: true, before }).then((page) => {
      if (page.kind !== 'read') {
        // Only while the view is still on this item and cursor: another item's read owns its failure.
        if (current.current?.uid === uid && current.current.earlierCursor === before) {
          setFailure({ uid, notFound: page.notFound })
        }
        return
      }
      // A page asked for from a cursor the view has since moved past (a second ask, or a retry) is stale.
      setLoaded((prev) =>
        prev?.uid === uid && prev.earlierCursor === before
          ? {
              ...prev,
              events: mergeBotItemEvents(page.value.events, prev.events),
              earlierCursor: page.value.earlierCursor ?? null
            }
          : prev
      )
    })
  }, [client, uid])

  const own = loaded?.uid === uid ? loaded : null
  // The waiting question is read even when older than the loaded page (an ask a later question left
  // open can be): earlier pages load until it shows.
  const waitingOn = own ? (own.item.waitingAsk ?? own.item.question?.eventId) : undefined
  const waitingUnread =
    waitingOn !== undefined && !own?.events.some((event) => event.id === waitingOn)
  const earlierCursor = own?.earlierCursor ?? null
  useEffect(() => {
    if (waitingUnread && earlierCursor) {
      loadEarlier()
    }
    // A retry reads again from the newest page, so it starts paging back again too.
  }, [waitingUnread, earlierCursor, loadEarlier, attempt])
  const failed = failure?.uid === uid ? failure : null
  return {
    item: own?.item ?? null,
    events: own?.events ?? [],
    hasEarlier: Boolean(own?.earlierCursor),
    failed: failed !== null,
    notFound: failed?.notFound === true && own === null,
    loadEarlier,
    retry: () => setAttempt((value) => value + 1)
  }
}
