import { createContext, type ReactElement } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatRowKeys } from './native-chat/transcript/mobile-native-chat-row-keys'

// Hold below-reader growth during scrolling because corrective writes stop iOS flings; notify only growing rows.
export type MobileNativeChatGrowthHold = {
  held: () => boolean
  subscribe: (onChange: () => void) => () => void
}

export function createMobileNativeChatGrowthHold(): MobileNativeChatGrowthHold & {
  set: (held: boolean) => void
} {
  let held = false
  const listeners = new Set<() => void>()
  return {
    held: () => held,
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    set: (next) => {
      if (next !== held) {
        held = next
        listeners.forEach((onChange) => onChange())
      }
    }
  }
}

const NEVER_HELD: MobileNativeChatGrowthHold = { held: () => false, subscribe: () => () => {} }

export const MobileNativeChatGrowthHoldContext =
  createContext<MobileNativeChatGrowthHold>(NEVER_HELD)

export type MobileNativeChatHeldRows = {
  rows: readonly NativeChatMessage[]
  header: ReactElement | null
  footer: ReactElement | null
  // Freeze renderItem too: grouping/turn context changes a row even if its message is unchanged.
  renderItem: (row: { item: NativeChatMessage; index: number }) => ReactElement
}

export function mobileNativeChatHeldRows(
  held: MobileNativeChatHeldRows | null,
  liveRows: readonly NativeChatMessage[],
  rowKeys: Pick<MobileNativeChatRowKeys, 'keyOf'>
) {
  const unheld = { rows: liveRows, heldFrom: Infinity, heldAt: 0 }
  const head = held?.rows[0]
  const at = head ? liveRows.findIndex((row) => rowKeys.keyOf(row) === rowKeys.keyOf(head)) : -1
  if (!held || at === -1) {
    return unheld
  }
  // Touch scrolling rebases its origin when history grows above it; insert only after rest.
  return { rows: held.rows, heldFrom: 0, heldAt: 0 }
}
