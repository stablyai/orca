// Unit 5 helper: pure ScreenFrame/stack utilities shared by hud-navigation.ts and screens/*.ts.
import type { NavState, ScreenFrame, ScreenId } from './nav-contract'

const LIST_LAYOUT_SCREENS: ReadonlySet<ScreenId> = new Set(['hostList', 'worktreeList'])

/** List layouts scroll natively in firmware; text layouts need our page-turn/cursor logic. */
export function isListLayoutScreen(screen: ScreenId): boolean {
  return LIST_LAYOUT_SCREENS.has(screen)
}

export function topFrame(state: NavState): ScreenFrame {
  return state.stack.at(-1)!
}

/** True when the visible frame is the bottom of the stack (nowhere left to pop). */
export function isRootFrame(state: NavState): boolean {
  return state.stack.length <= 1
}

export function pushFrame(state: NavState, frame: ScreenFrame): NavState {
  return { ...state, stack: [...state.stack, frame] }
}

export function popFrame(state: NavState): NavState {
  return { ...state, stack: state.stack.slice(0, -1) }
}

export function replaceTopFrame(state: NavState, frame: ScreenFrame): NavState {
  return { ...state, stack: [...state.stack.slice(0, -1), frame] }
}

/** hostId carried by frames that have one; null for pairing/hostList (no current host yet). */
export function frameHostId(frame: ScreenFrame): string | null {
  switch (frame.screen) {
    case 'dashboard':
    case 'worktreeList':
    case 'ask':
    case 'terminalTail':
      return frame.hostId
    default:
      return null
  }
}

/**
 * Boot-time root frame (spec S7): dashboard when exactly one host is known (skip straight to
 * the killer feature), else hostList. Takes the real host list directly rather than NavContext
 * since this runs once at boot before any input, outside the reducer's per-event contract.
 */
export function createInitialNavState(hosts: readonly { id: string }[]): NavState {
  const root: ScreenFrame =
    hosts.length === 1
      ? { screen: 'dashboard', hostId: hosts[0]!.id, page: 0 }
      : { screen: 'hostList', selectedIndex: 0 }
  return { stack: [root], exitDialogArmed: false }
}
