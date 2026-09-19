// Unit 5 helper: pure ScreenFrame/stack utilities shared by hud-navigation.ts and screens/*.ts.
import type { NavEffect, NavState, ScreenFrame, ScreenId } from './nav-contract'

const LIST_LAYOUT_SCREENS: ReadonlySet<ScreenId> = new Set(['hostList', 'worktreeList'])

/** Shared reducer return shape + no-op helpers, used by hud-navigation.ts and its split-out
 * per-screen reducer modules (hud-navigation-dashboard.ts, hud-navigation-list-select.ts). */
export type ReducedNav = { state: NavState; effects: NavEffect[] }

export const NO_EFFECTS: NavEffect[] = []

export function unchangedNav(state: NavState): ReducedNav {
  return { state, effects: NO_EFFECTS }
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Firmware list hard cap (spec S4/S8): shared between the reducer's page-boundary scroll
 * transitions/index resolution and the worktree-list screen's own render-time slicing. */
export const WORKTREE_LIST_PAGE_SIZE = 20

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
      ? { screen: 'dashboard', hostId: hosts[0]!.id, cursor: 0, page: 0 }
      : { screen: 'hostList', selectedIndex: 0 }
  return { stack: [root], exitDialogArmed: false }
}
