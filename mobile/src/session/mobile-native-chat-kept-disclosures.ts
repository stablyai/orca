import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Show more on a tool run: what the reader asked for, and the lines older calls added above. */
export type MobileNativeChatReveal = { requested: number; before: number; first?: string }

/** What the reader opened in one chat, by disclosure key. Plain maps: only the row that owns a key
 *  writes it, and it re-renders from its own state. */
export type MobileNativeChatKept = {
  open: Map<string, boolean>
  reveal: Map<string, MobileNativeChatReveal>
}

/** Provided where rows unmount once scrolled past (the phone page's window); elsewhere rows keep
 *  their own state as before. */
export const MobileNativeChatKeptContext = createContext<MobileNativeChatKept | null>(null)

export const MobileNativeChatDisclosureEpochContext = createContext<number | undefined>(undefined)

type Reset = { tools: boolean; turn: boolean; epoch: number }

/** Reset ownership includes evicted rows; returning to a prior toggle must never revive its keys. */
export function useMobileNativeChatDisclosureEpochs(
  rows: readonly NativeChatMessage[],
  keyOf: (row: NativeChatMessage) => string,
  rowState: (index: number, row: NativeChatMessage) => { turnExpanded: boolean },
  tools: boolean,
  scope: string
): ReadonlyMap<string, Reset> {
  const committed = useRef<{
    scope: string
    next: number
    rows: ReadonlyMap<string, Reset>
  } | null>(null)
  const before = committed.current?.scope === scope ? committed.current : null
  let next = before?.next ?? 0
  const resets = new Map<string, Reset>()
  rows.forEach((row, index) => {
    const key = keyOf(row)
    const turn = rowState(index, row).turnExpanded
    const previous = before?.rows.get(key)
    resets.set(
      key,
      previous?.tools === tools && previous.turn === turn
        ? previous
        : { tools, turn, epoch: next++ }
    )
  })
  useLayoutEffect(() => {
    committed.current = { scope, next, rows: resets }
  })
  return resets
}

/** One chat's kept disclosures; keyed by the chat so another chat starts with none. */
export function MobileNativeChatKeptScope({ children }: { children: ReactNode }): ReactElement {
  const [kept] = useState(newMobileNativeChatKept)
  return createElement(MobileNativeChatKeptContext.Provider, { value: kept }, children)
}

/** Bounded: a chat read for a day shouldn't carry every disclosure it ever opened. */
const MAX_KEPT = 512

export function newMobileNativeChatKept(): MobileNativeChatKept {
  return { open: new Map(), reveal: new Map() }
}

/** A row's own disclosure state that outlives the row: under windowing a row unmounts once it is
 *  scrolled past, and a reset would silently close what the reader opened (and change its height). */
export function useMobileNativeChatKept<T>(
  pick: (kept: MobileNativeChatKept) => Map<string, T>,
  key: string | undefined,
  initial: T
): [T, (next: (current: T) => T) => void] {
  const kept = useContext(MobileNativeChatKeptContext)
  const map = kept && key !== undefined ? pick(kept) : undefined
  const [value, setValue] = useState<T>(() =>
    key === undefined ? initial : (map?.get(key) ?? initial)
  )
  const set = useCallback(
    (next: (current: T) => T) => {
      const updated = next(value)
      if (map && key !== undefined) {
        map.delete(key)
        map.set(key, updated)
        const oldest = map.size > MAX_KEPT ? map.keys().next().value : undefined
        if (oldest !== undefined) {
          map.delete(oldest)
        }
      }
      setValue(updated)
    },
    [value, map, key]
  )
  return [value, set]
}
