import { Component, type RefObject } from 'react'
import { Platform } from 'react-native'
import { scrollWritesStopMomentum } from './mobile-native-chat-page-motion'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import {
  mobileNativeChatReadingParts,
  mobileNativeChatScrollRootKey,
  type MobileNativeChatScrollRoots
} from './mobile-native-chat-scroll-roots'

type Box = { top: number; bottom: number }

/** The parts of a DOM element this reads; on the page the list's scrollable node is one. */
type Tagged = {
  getBoundingClientRect: () => Box
  getAttribute: (name: string) => string | null
  querySelectorAll: (selector: string) => ArrayLike<Tagged>
}
type Scroller = Tagged & { scrollTop: number; scrollHeight: number; clientHeight: number }
export type MobileNativeChatScrollNode = Scroller

/** Part of what the reader sees: a tool line or its run (`member`), else a row; where it was, and
 *  the message that placed its row. */
type Unit = { key: string; top: number; member?: string; placed: string }

type Props = {
  children?: React.ReactNode
  roots?: MobileNativeChatScrollRoots
  runPlacements?: ReadonlyMap<string, string>
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'sourceHead' | 'current' | 'placement'>
  /** How rows draw (tools shown, text size); a change regroups and re-lays them like a new source. */
  layoutKey?: string
  /** Whether the reader follows the end, which then owns the scroll. */
  isFollowing: () => boolean
  /** On the page, the list makes the correction (`keepInPlace`), mid-scroll only for a regroup. */
  listRef: RefObject<{
    getScrollableNode: () => Scroller | null | undefined
    keepInPlace?: (drift: number, regrouped: boolean) => void
    holdPlace?: (on: boolean) => void
  } | null>
}

const ROW = 'chat-row:'
const MEMBER = 'chat-member:'

/** A message row's `testID`, which the page draws as `data-testid`. It sets message rows apart from
 *  the "Load earlier" control and the live status line, which don't move with the messages. */
export function mobileNativeChatRowId(key: string): string {
  return `${ROW}${key}`
}

/** A tool line's `testID`, by its line identity, or the run's, inside a row. */
export function mobileNativeChatMemberId(id: string): string {
  return `${MEMBER}${id}`
}

/** Tagged elements in document order; ids are compared, never put in a selector. */
function tagged(node: Tagged, prefix: string): { id: string; node: Tagged }[] {
  return Array.from(node.querySelectorAll(`[data-testid^="${prefix}"]`), (element) => ({
    id: element.getAttribute('data-testid')?.slice(prefix.length) ?? '',
    node: element
  }))
}

function onScreen(box: Box, view: Box): boolean {
  return box.bottom > view.top && box.top < view.bottom
}

/** A row's tool lines on screen, else its run when the run's top is (below that top, lines can join
 *  or leave), else the row itself. */
function unitsOf(row: Tagged, view: Box, self: Unit): Unit[] {
  const shown: Unit[] = []
  const parts =
    typeof Element !== 'undefined' && row instanceof Element
      ? mobileNativeChatReadingParts(row).map((node) => ({
          node,
          id:
            mobileNativeChatScrollRootKey(node) !== undefined
              ? `root:${mobileNativeChatScrollRootKey(node)}`
              : (node.getAttribute('data-testid')?.slice(MEMBER.length) ?? '')
        }))
      : tagged(row, MEMBER)
  for (const { id, node } of parts) {
    const box = node.getBoundingClientRect()
    if (box.top >= view.bottom) {
      break
    }
    if (id === 'run' ? box.top >= view.top : onScreen(box, view)) {
      shown.push({ ...self, top: box.top, member: id })
    }
  }
  const lines = shown.filter((unit) => unit.member !== 'run')
  return lines.length > 0 ? lines : [shown[0] ?? self]
}

/** What the reader is reading, in page order. */
function placeOnScreen(scroller: Scroller, { placement }: Props['rowKeys']): Unit[] {
  const view = scroller.getBoundingClientRect()
  const rows = tagged(scroller, ROW)
  // Rows in normal flow have ordered bottoms, so the first one on screen is found without
  // measuring the up to 2,000 above it.
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (rows[middle]!.node.getBoundingClientRect().bottom <= view.top) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  let end = low
  while (end < rows.length && rows[end]!.node.getBoundingClientRect().top < view.bottom) {
    end += 1
  }
  const self = ({ id, node }: { id: string; node: Tagged }): Unit => {
    return { key: id, top: node.getBoundingClientRect().top, placed: placement(id) }
  }
  const units = rows.slice(low, end).flatMap((row) => unitsOf(row.node, view, self(row)))
  // The nearest rows off screen stand in when the update takes away all that was on it.
  return units.concat([rows[end], rows[low - 1]].flatMap((row) => (row ? [self(row)] : [])))
}

/** Where a held part is drawn now, if the update kept it. A line in the row now drawing its old
 *  row's messages (an orphan result's line is its call's once paired); a run only in the row that
 *  kept its key; a row only while the same message places it, since a group keeps its key when the
 *  fold moves it. */
function drawn(
  unit: Unit,
  rows: Map<string, Tagged>,
  keys: Props['rowKeys'],
  roots?: MobileNativeChatScrollRoots
): Tagged | undefined {
  const { key, member } = unit
  if (member?.startsWith('root:')) {
    return roots?.frame(member.slice(5))
  }
  if (member === undefined) {
    return keys.placement(key) === unit.placed ? rows.get(key) : undefined
  }
  const row = rows.get(member === 'run' ? key : (keys.current(key) ?? ''))
  const paired = member.startsWith('result:') ? `call:${member.slice('result:'.length)}` : member
  return row && tagged(row, MEMBER).find((m) => m.id === member || m.id === paired)?.node
}

/** The update moves what the reader reads to another row (a line to another group, a row placed by
 *  another message): the browser's anchoring loses that node, so the hold puts it back. */
function moves(
  unit: Unit | undefined,
  keys: Props['rowKeys'],
  placements?: ReadonlyMap<string, string>,
  roots?: MobileNativeChatScrollRoots
): boolean {
  if (!unit) {
    return false
  }
  if (unit.member === undefined) {
    return keys.placement(unit.key) !== unit.placed
  }
  if (unit.member.startsWith('root:')) {
    const owner = roots?.owner(unit.member.slice(5))
    const now = owner === undefined ? undefined : placements?.get(owner)
    return now !== undefined && now !== unit.placed
  }
  // An orphan result's line goes to its call's row once the call lands, and its old row stays.
  return (
    unit.member.startsWith('result:') ||
    (unit.member !== 'run' && keys.current(unit.key) !== unit.key)
  )
}

/** iOS is still bouncing the list past an end. A write then lands while WebKit owns the scroll, and
 *  the list stops taking the reader's scrolls until they leave the chat. */
function overscrolled({ scrollTop, scrollHeight, clientHeight }: Scroller): boolean {
  return scrollTop < 0 || scrollTop > scrollHeight - clientHeight + 1
}

/** Keeps a parked reader's place on the page when the source window changes above them (an older
 *  page, a cap trim) or the rows regroup (Tools, text size): the first part of what they were reading that the update kept goes back where
 *  it was. Where the browser has scroll anchoring it keeps the place through ordinary changes, so the
 *  hold runs only for a regroup or a move to another row, with the browser's anchoring off from
 *  before the update until its correction. A following reader is left to the follow owner, which
 *  holds the end. A class because only `getSnapshotBeforeUpdate` sees the rows before the update is
 *  in the document. A native list holds its own place (`maintainVisibleContentPosition`). */
export class MobileNativeChatScrollHold extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): Unit[] | null {
    const regrouped = previous.layoutKey !== this.props.layoutKey
    const moved = new Set(
      Array.from(previous.runPlacements ?? []).flatMap(([owner, row]) =>
        this.props.runPlacements?.get(owner) !== row ? [owner] : []
      )
    )
    if (Platform.OS === 'web' && previous.rowKeys.scope === this.props.rowKeys.scope) {
      this.props.roots?.capture(moved, regrouped)
    }
    // Another chat opens at its end, which the follow owner resets only after this reads it.
    if (
      Platform.OS !== 'web' ||
      previous.rowKeys.scope !== this.props.rowKeys.scope ||
      (previous.rowKeys.sourceHead === this.props.rowKeys.sourceHead &&
        !regrouped &&
        moved.size === 0) ||
      this.props.isFollowing()
    ) {
      return null
    }
    const list = this.props.listRef.current
    const scroller = list?.getScrollableNode()
    const held =
      scroller && !overscrolled(scroller) ? placeOnScreen(scroller, previous.rowKeys) : null
    if (
      !held ||
      (!scrollWritesStopMomentum() &&
        !regrouped &&
        !moves(held[0], this.props.rowKeys, this.props.runPlacements, this.props.roots))
    ) {
      return null
    }
    list?.holdPlace?.(true)
    return held
  }

  componentDidMount(): void {
    this.props.roots?.restoreAll()
  }

  componentDidUpdate(previous: Props, _state: unknown, held: Unit[] | null): void {
    try {
      const regrouped = previous.layoutKey !== this.props.layoutKey
      this.props.roots?.restoreAll(regrouped, false)
      if (held) {
        this.restore(held, regrouped)
      }
    } finally {
      this.props.roots?.releaseHold()
      // Whatever the correction did, the scroll goes back to its owner.
      if (held) {
        this.props.listRef.current?.holdPlace?.(false)
      }
    }
  }

  private restore(held: Unit[], regrouped: boolean): void {
    const list = this.props.listRef.current
    const scroller = held.length ? list?.getScrollableNode() : null
    if (!scroller) {
      return
    }
    const rows = new Map(tagged(scroller, ROW).map(({ id, node }) => [id, node]))
    for (const unit of held) {
      const node = drawn(unit, rows, this.props.rowKeys, this.props.roots)
      if (node) {
        const drift = node.getBoundingClientRect().top - unit.top
        // Sub-pixel drift is layout noise; a write would stop iOS momentum for nothing.
        if (Math.abs(drift) >= 0.5 && list?.keepInPlace) {
          list.keepInPlace(drift, regrouped)
        } else if (Math.abs(drift) >= 0.5) {
          scroller.scrollTop += drift
        }
        return
      }
    }
  }

  render(): React.ReactNode {
    return this.props.children ?? null
  }
}
