import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
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
export type MobileNativeChatScrollNode = Tagged & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type Keys = Pick<MobileNativeChatRowKeys, 'current' | 'placement'>

export type MobileNativeChatReadingUnit = {
  key: string
  top: number
  member?: string
  placed: string
}

const ROW = 'chat-row:'
const MEMBER = 'chat-member:'

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

export function mobileNativeChatReadingPlace(
  scroller: MobileNativeChatScrollNode,
  { placement }: Keys
): MobileNativeChatReadingUnit[] {
  const view = scroller.getBoundingClientRect()
  const rows = tagged(scroller, ROW)
  // Binary-search ordered row bottoms to avoid measuring thousands of offscreen rows.
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
  const self = ({ id, node }: { id: string; node: Tagged }): MobileNativeChatReadingUnit => {
    return { key: id, top: node.getBoundingClientRect().top, placed: placement(id) }
  }
  const units = rows.slice(low, end).flatMap((row) => unitsOf(row.node, view, self(row)))
  // The nearest rows off screen stand in when the update takes away all that was on it.
  return units.concat([rows[end], rows[low - 1]].flatMap((row) => (row ? [self(row)] : [])))
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
  const rows = new Map(tagged(scroller, ROW).map(({ id, node }) => [id, node]))
  for (const unit of place) {
    const node = drawn(unit, rows, keys, roots)
    if (node) {
      return node.getBoundingClientRect().top - unit.top
    }
  }
  return 0
}
