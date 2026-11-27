// Next and previous item on the item page, as the desktop's stepper walks: through the section the item
// was opened from, fixed at open. Stepping onto a Closed item not read yet reads the next page first; the
// current item stays up meanwhile. An item opened from elsewhere (a link, Needs you) has no walk.
import { useEffect, useRef, useState } from 'react'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import {
  botItemWalkExtend,
  botItemWalkIndex,
  botItemWalkStep,
  type BotItemWalk
} from '../../../../src/shared/bots/bot-item-walk'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PhoneBotItems } from './use-phone-bot-items'

type Open = {
  /** The item the page opened on. */
  from: string
  uid: string
  walk: BotItemWalk
}

export type PhoneBotItemStepper = {
  /** 1-based. */
  index: number
  total: number
  canStep: (direction: 1 | -1) => boolean
  step: (direction: 1 | -1) => void
}

export function usePhoneBotItemWalk({
  items: { loadMoreClosed, closedEnded },
  pager,
  showToast,
  opened
}: {
  /** The list the Items tab shows. */
  items: Pick<PhoneBotItems, 'loadMoreClosed' | 'closedEnded'>
  /** Pushes the item's page; a step keeps it and shows the next item in it. */
  pager: { open: (page: `item:${string}`) => void }
  showToast: (message: string) => void
  /** What the panel last opened on: a new open (a link to an item, or the list) starts with no walk. */
  opened: unknown
}) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState<Open | null>(null)
  // The open a Closed page is being read for: a read that lands after another open is dropped.
  const [reading, setReading] = useState<Open | null>(null)
  const [lastOpened, setLastOpened] = useState(opened)
  if (lastOpened !== opened) {
    setLastOpened(opened)
    setOpen(null)
  }
  const shown = useRef(open)
  useEffect(() => {
    shown.current = open
  })

  const readFailed = () =>
    showToast(t('bots.items.readFailedClosedPage', 'Couldn’t read more closed items.'))

  const step = (current: Open, direction: 1 | -1): void => {
    const first = botItemWalkStep(current.walk, current.uid, direction)
    if (!first || reading === current) {
      return
    }
    if (first.kind === 'open') {
      setOpen({ ...current, uid: first.uid })
      return
    }
    // The next member is a Closed item the walk hasn't read: the host's next page has it. With no
    // page left the count was more than the host holds; otherwise the list is reading its pages again.
    if (!loadMoreClosed) {
      if (closedEnded) {
        setOpen({ ...current, walk: botItemWalkExtend(current.walk, [], true) })
      } else {
        readFailed()
      }
      return
    }
    setReading(current)
    loadMoreClosed()
      .then((page) => {
        const walk = botItemWalkExtend(current.walk, page.items, !page.more)
        const next = botItemWalkStep(walk, current.uid, direction)
        setOpen((now) =>
          now === current
            ? { ...current, walk, uid: next?.kind === 'open' ? next.uid : current.uid }
            : now
        )
      })
      .catch(() => {
        if (shown.current === current) {
          readFailed()
        }
      })
      .finally(() => setReading((now) => (now === current ? null : now)))
  }

  return {
    /** Opens `item` from the list, with `walk` its section as it shows now; null: no walk. */
    open: ({ uid }: BotItem, walk: BotItemWalk | null) => {
      setOpen(walk ? { from: uid, uid, walk } : null)
      pager.open(`item:${uid}`)
    },
    /** The item shown on the page opened on `from`, and its stepper; none without a walk. */
    shown: (from: string): { uid: string; stepper: PhoneBotItemStepper | null } => {
      if (open?.from !== from) {
        return { uid: from, stepper: null }
      }
      const index = botItemWalkIndex(open.walk, open.uid) ?? 0
      return {
        uid: open.uid,
        stepper: {
          index: index + 1,
          total: open.walk.total,
          canStep: (direction) =>
            reading !== open && botItemWalkStep(open.walk, open.uid, direction) !== null,
          step: (direction) => step(open, direction)
        }
      }
    }
  }
}
