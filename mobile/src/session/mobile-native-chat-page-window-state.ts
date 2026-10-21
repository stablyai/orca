import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'

type Box = { top: number; bottom: number }
type Measured = { getBoundingClientRect: () => Box }

export type MobileNativeChatWindowScroller = Measured & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  style?: { overflowAnchor: string }
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options: { passive: true }
  ) => void
  removeEventListener: (type: string, listener: (event: unknown) => void) => void
}

export type MobileNativeChatWindowRowState = (
  index: number,
  row: NativeChatMessage
) => MobileNativeChatTurnRow
export type MobileNativeChatWindowGroup = { from: string; fromAt: number; to: string; toAt: number }

/** Where the window stands, by key, so landings and trims never change which rows are drawn. */
export type MobileNativeChatWindowSeat = {
  scope: string
  first: string
  firstAt: number
  last: string | null
  lastAt: number
  /** Measured rows trimmed from above a parked reader: their height stays until settled. */
  slack: number
  /** Rows drawn in place above the window only so they get measured. */
  measure: MobileNativeChatWindowGroup | null
}

export type MobileNativeChatWindowDrawn = {
  keys: readonly string[]
  rows: readonly NativeChatMessage[]
  indexOf: (key: string | undefined) => number | undefined
  rowState: MobileNativeChatWindowRowState
  start: number
  end: number
  /** The first row in the document: rows above it were never measured. */
  first: number
  sourceHead: string | undefined
  following: boolean
  layoutKey: string
}

export type MobileNativeChatPageWindowArgs = {
  roots?: MobileNativeChatScrollRoots
  rows: readonly NativeChatMessage[]
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'sourceHead' | 'keyOf' | 'current'>
  rowState: MobileNativeChatWindowRowState
  following: boolean
  /** At event time, before a re-render lands. */
  isFollowing: () => boolean
  layoutKey: string
  scroller: () => MobileNativeChatWindowScroller | null | undefined
}
