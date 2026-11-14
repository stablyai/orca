import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import {
  mobileNativeChatRowTop,
  mobileNativeChatTopRow,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import type {
  MobileNativeChatPlace,
  MobileNativeChatRestore
} from './mobile-native-chat-saved-places'

// Draw from a batch above the row, so the reader can keep scrolling up from it.
const DRAW_ABOVE = 12

type Drawn = {
  indexOf: ReadonlyMap<string, number>
  keys: readonly string[]
  first: number
  n: number
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope'>
}

/** The page list's place methods: read the reader's top row, and put a saved place back. */
export function mobileNativeChatPagePlaces<S extends MobileNativeChatScrollNode>(
  scroller: () => S | null,
  drawn: () => Drawn,
  setDrawn: (next: { scope: string; firstKey: string; count: number }) => void,
  write: (scroller: S, to: number) => void,
  notePlace: (scroller: S) => void
) {
  return {
    readPlace: () => {
      const s = scroller()
      return s ? mobileNativeChatTopRow(s) : undefined
    },
    restorePlace: (place: MobileNativeChatPlace): MobileNativeChatRestore => {
      const s = scroller()
      if (!s) {
        return 'pending'
      }
      const at = drawn()
      const drawFrom = (from: number) =>
        setDrawn({ scope: at.rowKeys.scope, firstKey: at.keys[from] ?? '', count: at.n - from })
      const scrollBy = (by: number) => {
        write(s, s.scrollTop + by)
        notePlace(s)
      }
      return restorePlace(s, place, at, drawFrom, scrollBy)
    }
  }
}

/** Puts a saved place back on the page list: draws its row first when it is above the drawn range. */
function restorePlace(
  scroller: MobileNativeChatScrollNode,
  { key, offset }: MobileNativeChatPlace,
  drawn: { indexOf: ReadonlyMap<string, number>; first: number; n: number },
  drawFrom: (index: number) => void,
  scrollBy: (delta: number) => void
): MobileNativeChatRestore {
  const index = drawn.indexOf.get(key)
  if (drawn.n === 0) {
    return 'pending'
  }
  if (index === undefined) {
    return 'missing'
  }
  if (index < drawn.first) {
    drawFrom(Math.max(0, index - DRAW_ABOVE))
    return 'pending'
  }
  const top = mobileNativeChatRowTop(scroller, key)
  if (top === undefined) {
    return 'pending'
  }
  scrollBy(top - scroller.getBoundingClientRect().top + offset)
  return 'restored'
}
