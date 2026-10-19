import { Component, type RefObject } from 'react'
import { Platform } from 'react-native'

type Box = { top: number; bottom: number }

/** The parts of a DOM element this reads; on the page the list's scrollable node is one. */
type RowElement = {
  isConnected: boolean
  getBoundingClientRect: () => Box
  children: ArrayLike<RowElement>
}
type Scroller = {
  scrollTop: number
  getBoundingClientRect: () => Box
  firstElementChild: RowElement | null
}

type Held = { row: RowElement; top: number }

type Props = {
  /** The first row's key: a change in it is rows changing above the reader. */
  headKey: string | undefined
  listRef: RefObject<{ getScrollableNode: () => Scroller | null | undefined } | null>
}

/** The lowest row on screen. Why the lowest: the "Load earlier" control stays at the top while
 *  history lands under it, so the topmost element does not move with the rows. */
function lowestRowOnScreen(scroller: Scroller): Held | null {
  const content = scroller.firstElementChild
  if (!content) {
    return null
  }
  const view = scroller.getBoundingClientRect()
  // The list's own rows, then the rows of the header block that precedes them.
  const header = content.children[0]
  for (const rows of [content.children, header?.children ?? []]) {
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      const box = rows[at].getBoundingClientRect()
      if (box.top < view.bottom && box.bottom > view.top && rows[at] !== header) {
        return { row: rows[at], top: box.top }
      }
    }
  }
  return null
}

/** Keeps the page's view on the same rows when rows above it change, by putting a row that was on
 *  screen back where it was. A class because only `getSnapshotBeforeUpdate` sees that row before
 *  the new ones are in the document. A native list holds its own place
 *  (`maintainVisibleContentPosition`). */
export class MobileNativeChatScrollHold extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): Held | null {
    if (Platform.OS !== 'web' || previous.headKey === this.props.headKey) {
      return null
    }
    const scroller = this.props.listRef.current?.getScrollableNode()
    return scroller ? lowestRowOnScreen(scroller) : null
  }

  componentDidUpdate(_previous: Props, _state: unknown, held: Held | null): void {
    const scroller = held?.row.isConnected ? this.props.listRef.current?.getScrollableNode() : null
    if (held && scroller) {
      scroller.scrollTop += held.row.getBoundingClientRect().top - held.top
    }
  }

  render(): null {
    return null
  }
}
