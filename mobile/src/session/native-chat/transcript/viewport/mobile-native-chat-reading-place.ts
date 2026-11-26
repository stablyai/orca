import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import {
  mobileNativeChatReadingParts,
  mobileNativeChatScrollRootKey
} from './mobile-native-chat-scroll-root-handle'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'

type Box = { top: number; bottom: number }

type Tagged = {
  getBoundingClientRect: () => Box
  getAttribute: (name: string) => string | null
  querySelectorAll: (selector: string) => ArrayLike<Tagged>
}
type RowChild = Tagged & {
  children: ArrayLike<Tagged>
  nextElementSibling: RowChild | null
}
type RowBox = {
  children: ArrayLike<RowChild>
  nextElementSibling: RowChild | null
}
export type MobileNativeChatScrollNode = Tagged & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  querySelector: (selector: string) => RowBox | null
}

type Listen = (type: string, listener: () => void, options: AddEventListenerOptions) => void
export type MobileNativeChatPageScroller = MobileNativeChatScrollNode & {
  addEventListener: Listen
  removeEventListener: Listen
}

// RN 0.88 types these handles as native tags; on web they are the DOM nodes this list observes.
export function isMobileNativeChatPageScroller(
  node: unknown
): node is MobileNativeChatPageScroller {
  return typeof node === 'object' && node !== null && 'addEventListener' in node
}

type Keys = Pick<MobileNativeChatRowKeys, 'current' | 'placement'>

export type MobileNativeChatReadingUnit = {
  key: string
  /** From the scroller's top, so a place saved on an earlier visit holds if the scroller moved. */
  top: number
  member?: string
  placed: string
}

/** How many screens of rows the page list draws above the view. */
export const DRAW_AHEAD_SCREENS = 3

const ROW = 'chat-row:'
const MEMBER = 'chat-member:'
const ROWS = 'data-chat-rows'

// Lets the reading place index rows instead of searching the page.
export const mobileNativeChatRowBoxProps = { [ROWS]: '' }

export function mobileNativeChatRowId(key: string): string {
  return `${ROW}${key}`
}

export function mobileNativeChatMemberId(id: string): string {
  return `${MEMBER}${id}`
}

function membersOf(row: Tagged): { id: string; node: Tagged }[] {
  return Array.from(row.querySelectorAll(`[data-testid^="${MEMBER}"]`), (element) => ({
    id: element.getAttribute('data-testid')?.slice(MEMBER.length) ?? '',
    node: element
  }))
}

function onScreen(box: Box, view: Box): boolean {
  return box.bottom > view.top && box.top < view.bottom
}

// Prefer visible tool lines, then a visible run header, then the row as reading anchors.
function unitsOf(
  row: Tagged,
  view: Box,
  self: MobileNativeChatReadingUnit
): MobileNativeChatReadingUnit[] {
  const shown: MobileNativeChatReadingUnit[] = []
  const parts =
    typeof Element !== 'undefined' && row instanceof Element
      ? mobileNativeChatReadingParts(row).map((node) => ({
          node,
          id:
            mobileNativeChatScrollRootKey(node) !== undefined
              ? `root:${mobileNativeChatScrollRootKey(node)}`
              : (node.getAttribute('data-testid')?.slice(MEMBER.length) ?? '')
        }))
      : membersOf(row)
  for (const { id, node } of parts) {
    const box = node.getBoundingClientRect()
    if (box.top >= view.bottom) {
      break
    }
    if (id === 'run' ? box.top >= view.top : onScreen(box, view)) {
      shown.push({ ...self, top: box.top - view.top, member: id })
    }
  }
  const lines = shown.filter((unit) => unit.member !== 'run')
  return lines.length > 0 ? lines : [shown[0] ?? self]
}

type DrawnRow = { id: string; node: Tagged }

function taggedRow(node: Tagged): DrawnRow | undefined {
  const tag = node.getAttribute('data-testid')
  return tag?.startsWith(ROW) ? { id: tag.slice(ROW.length), node } : undefined
}

function rowIn(child: RowChild): DrawnRow | undefined {
  const row = taggedRow(child)
  if (row) {
    return row
  }
  // Activity join wrappers put the tagged row one level down.
  for (let index = 0; index < child.children.length; index += 1) {
    const wrapped = taggedRow(child.children[index]!)
    if (wrapped) {
      return wrapped
    }
  }
  return undefined
}

// The row box's children plus footer waiting rows after it.
function drawnRows(scroller: MobileNativeChatScrollNode): DrawnRow[] {
  const box = scroller.querySelector(`[${ROWS}]`)
  if (!box) {
    return []
  }
  const rows = Array.from(box.children).flatMap((child) => rowIn(child) ?? [])
  for (let next = box.nextElementSibling; next; next = next.nextElementSibling) {
    const row = rowIn(next)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

// Binary-search ordered row bottoms to avoid measuring thousands of offscreen rows.
function firstRowEndingBelow(rows: readonly DrawnRow[], y: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (rows[middle]!.node.getBoundingClientRect().bottom <= y) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** Read drawn row tops relative to the view, indexing the DOM only if a row is queried. */
export function mobileNativeChatRowOffsets(scroller: MobileNativeChatScrollNode) {
  let rows: Map<string, Tagged> | undefined
  let top: number
  return (key: string): number | undefined => {
    if (!rows) {
      rows = new Map(drawnRows(scroller).map(({ id, node }) => [id, node]))
      top = scroller.getBoundingClientRect().top
    }
    const row = rows.get(key)
    return row && row.getBoundingClientRect().top - top
  }
}

// The nearest row wholly more than `distance` above the view; it ends at or above that line.
export function mobileNativeChatRowAbove(
  scroller: MobileNativeChatScrollNode,
  distance: number
): string | undefined {
  const rows = drawnRows(scroller)
  const below = firstRowEndingBelow(rows, scroller.getBoundingClientRect().top - distance)
  return rows[below - 1]?.id
}

export function mobileNativeChatReadingPlace(
  scroller: MobileNativeChatScrollNode,
  { placement }: Keys
): MobileNativeChatReadingUnit[] {
  const view = scroller.getBoundingClientRect()
  const rows = drawnRows(scroller)
  const low = firstRowEndingBelow(rows, view.top)
  let end = low
  while (end < rows.length && rows[end]!.node.getBoundingClientRect().top < view.bottom) {
    end += 1
  }
  const unit = ({ id, node }: DrawnRow): MobileNativeChatReadingUnit => ({
    key: id,
    top: node.getBoundingClientRect().top - view.top,
    placed: placement(id)
  })
  const units = rows.slice(low, end).flatMap((row) => unitsOf(row.node, view, unit(row)))
  // The nearest rows off screen stand in when the update takes away all that was on it.
  const nearest = [rows[end], rows[low - 1]]
  return units.concat(nearest.flatMap((row) => (row ? [unit(row)] : [])))
}

// Follow paired results into their call’s row; runs/rows retain anchors only while their original placement identity survives.
function drawn(
  unit: MobileNativeChatReadingUnit,
  rows: Map<string, Tagged>,
  keys: Keys,
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
  return row && membersOf(row).find((m) => m.id === member || m.id === paired)?.node
}

/** How far the place's first still-drawn unit moved; undefined when none of it is drawn. */
export function mobileNativeChatReadingDrift(
  place: readonly MobileNativeChatReadingUnit[],
  scroller: MobileNativeChatScrollNode,
  keys: Keys,
  roots?: MobileNativeChatScrollRoots
): number | undefined {
  const rows = new Map(drawnRows(scroller).map(({ id, node }) => [id, node]))
  for (const unit of place) {
    const node = drawn(unit, rows, keys, roots)
    if (node) {
      return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - unit.top
    }
  }
  return undefined
}
