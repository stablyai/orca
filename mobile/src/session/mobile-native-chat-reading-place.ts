import type { MobileNativeChatRowKeys } from './native-chat/transcript/mobile-native-chat-row-keys'
import {
  mobileNativeChatReadingParts,
  mobileNativeChatScrollRootKey,
  type MobileNativeChatScrollRoots
} from './mobile-native-chat-scroll-roots'

type Box = { top: number; bottom: number }

type Tagged = {
  getBoundingClientRect: () => Box
  getAttribute: (name: string) => string | null
  querySelectorAll: (selector: string) => ArrayLike<Tagged>
}
type Sibling = Tagged & { children?: ArrayLike<Sibling>; nextElementSibling: Sibling | null }
type RowBox = Sibling & { children: ArrayLike<Sibling> }
export type MobileNativeChatScrollNode = Tagged & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  querySelector: (selector: string) => RowBox | null
}

type Keys = Pick<MobileNativeChatRowKeys, 'current' | 'placement'>

export type MobileNativeChatDrawnWindow = {
  scope: string
  firstKey: string | null
  count: number
  fromStart?: boolean
  detached?: boolean
  automatic?: boolean
}

export type MobileNativeChatReadingUnit = {
  key: string
  top: number
  member?: string
  placed: string
}

const ROW = 'chat-row:'
const MEMBER = 'chat-member:'
const ROWS = 'data-chat-rows'
const PAGE_ROW = 'data-native-chat-page-row'

// Lets the reading place index rows instead of searching the page.
export const mobileNativeChatRowBoxProps = { [ROWS]: '' }

export function mobileNativeChatRowId(key: string): string {
  return `${ROW}${key}`
}

export function mobileNativeChatMemberId(id: string): string {
  return `${MEMBER}${id}`
}

// Compare ids directly; do not interpolate arbitrary ids into selectors.
function tagged(node: Tagged, prefix: string): { id: string; node: Tagged }[] {
  return Array.from(node.querySelectorAll(`[data-testid^="${prefix}"]`), (element) => ({
    id: element.getAttribute('data-testid')?.slice(prefix.length) ?? '',
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

function rowIdOf(node: Tagged): string | undefined {
  const id = node.getAttribute('data-testid')
  return id?.startsWith(ROW) ? id.slice(ROW.length) : undefined
}

// The row box's children plus footer waiting rows after it; ids are read only where needed.
function drawnRows(scroller: MobileNativeChatScrollNode): Sibling[] {
  const box = scroller.querySelector(`[${ROWS}]`)
  if (!box) {
    return []
  }
  const rows = Array.from(box.children).flatMap((row) =>
    row.getAttribute(PAGE_ROW) !== null ? Array.from(row.children ?? []) : [row]
  )
  for (let next = box.nextElementSibling; next; next = next.nextElementSibling) {
    if (rowIdOf(next) !== undefined) {
      rows.push(next)
    }
  }
  return rows
}

// Binary-search ordered row bottoms to avoid measuring thousands of offscreen rows.
function firstRowEndingBelow(rows: readonly Tagged[], y: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (rows[middle]!.getBoundingClientRect().bottom <= y) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

// Turn-status lines sit between rows untagged, so step past them to the nearest tagged row.
function nearestRow(
  rows: readonly Tagged[],
  from: number,
  step: 1 | -1
): { id: string; node: Tagged } | undefined {
  for (let at = from; at >= 0 && at < rows.length; at += step) {
    const id = rowIdOf(rows[at]!)
    if (id !== undefined) {
      return { id, node: rows[at]! }
    }
  }
  return undefined
}

// The nearest row wholly more than `distance` above the view; it ends at or above that line.
export function mobileNativeChatRowAbove(
  scroller: MobileNativeChatScrollNode,
  distance: number
): string | undefined {
  const rows = drawnRows(scroller)
  const below = firstRowEndingBelow(rows, scroller.getBoundingClientRect().top - distance)
  return nearestRow(rows, below - 1, -1)?.id
}

export function mobileNativeChatReadingPlace(
  scroller: MobileNativeChatScrollNode,
  { placement }: Keys
): MobileNativeChatReadingUnit[] {
  const view = scroller.getBoundingClientRect()
  const rows = drawnRows(scroller)
  const low = firstRowEndingBelow(rows, view.top)
  let end = low
  while (end < rows.length && rows[end]!.getBoundingClientRect().top < view.bottom) {
    end += 1
  }
  const unit = ({ id, node }: { id: string; node: Tagged }): MobileNativeChatReadingUnit => ({
    key: id,
    top: node.getBoundingClientRect().top,
    placed: placement(id)
  })
  const units = rows.slice(low, end).flatMap((node) => {
    const id = rowIdOf(node)
    return id === undefined ? [] : unitsOf(node, view, unit({ id, node }))
  })
  // The nearest rows off screen stand in when the update takes away all that was on it.
  const nearest = [nearestRow(rows, end, 1), nearestRow(rows, low - 1, -1)]
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
  return row && tagged(row, MEMBER).find((m) => m.id === member || m.id === paired)?.node
}

export function mobileNativeChatReadingDrift(
  place: readonly MobileNativeChatReadingUnit[],
  scroller: MobileNativeChatScrollNode,
  keys: Keys,
  roots?: MobileNativeChatScrollRoots
): number {
  const rows = new Map(
    drawnRows(scroller).flatMap((node) => {
      const id = rowIdOf(node)
      return id === undefined ? [] : [[id, node] as const]
    })
  )
  for (const unit of place) {
    const node = drawn(unit, rows, keys, roots)
    if (node) {
      return node.getBoundingClientRect().top - unit.top
    }
  }
  return 0
}

export function measureMobileNativeChatPageRows(
  scroller: MobileNativeChatScrollNode,
  heights: Map<string, number>
): void {
  for (const row of Array.from(scroller.querySelectorAll(`[${PAGE_ROW}]`))) {
    const key = row.getAttribute(PAGE_ROW)
    if (key !== null) {
      const box = row.getBoundingClientRect()
      heights.set(key, box.bottom - box.top)
    }
  }
}

export function mobileNativeChatUndrawnHeight(
  keys: readonly string[],
  first: number,
  heights: ReadonlyMap<string, number>
): number {
  let height = 0
  for (let index = 0; index < first; index += 1) {
    height += heights.get(keys[index]!) ?? 0
  }
  return height
}
