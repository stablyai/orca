// Unit 5: pure navigation reducer (spec S7). No bridge/transport imports — reduceHudInput is
// (NavState, HudInput, NavContext) -> { state, effects }, fully unit-testable in isolation.
import type { HudInput, NavContext, NavEffect, NavState, ScreenFrame } from './nav-contract'
import { clampAskCursor, resolveAskQuickAction } from './ask-quick-action'
import {
  frameHostId,
  isListLayoutScreen,
  isRootFrame,
  popFrame,
  pushFrame,
  replaceTopFrame,
  topFrame
} from './hud-navigation-frames'

export { createInitialNavState } from './hud-navigation-frames'

export type ReducedNav = { state: NavState; effects: NavEffect[] }

const NO_EFFECTS: NavEffect[] = []

function unchanged(state: NavState): ReducedNav {
  return { state, effects: NO_EFFECTS }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function reduceHudInput(state: NavState, input: HudInput, ctx: NavContext): ReducedNav {
  switch (input.kind) {
    case 'doubleClick':
      return reduceDoubleClick(state)
    case 'scrollPrev':
      return reduceScroll(state, ctx, -1)
    case 'scrollNext':
      return reduceScroll(state, ctx, 1)
    case 'click':
      return reduceClick(state, ctx)
    case 'listSelect':
      return reduceListSelect(state, ctx, input.index)
    case 'foregroundEnter':
      return reduceForegroundEnter(state)
    case 'foregroundExit':
      return reduceForegroundExit(state)
    case 'systemExit':
      return reduceSystemExit(state)
    case 'abnormalExit':
      return reduceAbnormalExit(state)
    default:
      return unchanged(state)
  }
}

// --- doubleClick: pop one frame; on root, request the exit dialogue (spec: root double-tap
// must call shutDownPageContainer(1)). ---
function reduceDoubleClick(state: NavState): ReducedNav {
  if (isRootFrame(state)) {
    return {
      state: { ...state, exitDialogArmed: true },
      effects: [{ kind: 'requestShutdownDialog' }]
    }
  }
  const popped = topFrame(state)
  const effects: NavEffect[] =
    popped.screen === 'terminalTail' && popped.terminalId
      ? [{ kind: 'closeTerminalTail', terminalId: popped.terminalId }]
      : NO_EFFECTS
  return { state: popFrame(state), effects }
}

// --- scroll: list layouts are a no-op (firmware scrolls natively); text layouts page-turn or
// move a cursor depending on the screen. ---
function reduceScroll(state: NavState, ctx: NavContext, direction: -1 | 1): ReducedNav {
  const frame = topFrame(state)
  if (isListLayoutScreen(frame.screen)) {
    return unchanged(state)
  }

  if (frame.screen === 'dashboard') {
    return reduceDashboardScroll(state, ctx, frame, direction)
  }
  if (frame.screen === 'terminalTail') {
    return reduceTerminalTailScroll(state, ctx, frame, direction)
  }
  if (frame.screen === 'ask') {
    return reduceAskScroll(state, ctx, frame, direction)
  }
  return unchanged(state) // pairing: nothing to scroll
}

type DashboardFrame = Extract<ScreenFrame, { screen: 'dashboard' }>
type TerminalTailFrame = Extract<ScreenFrame, { screen: 'terminalTail' }>
type AskFrame = Extract<ScreenFrame, { screen: 'ask' }>
type HostListFrame = Extract<ScreenFrame, { screen: 'hostList' }>
type WorktreeListFrame = Extract<ScreenFrame, { screen: 'worktreeList' }>

// Dashboard's `page` field is dual-purpose: a row cursor when the dashboard fits on one page
// (scroll = select, click = drill into that worktree), a page index once it doesn't
// (scroll = page-turn, click = open worktreeList) — spec's "footer states current click meaning".
function reduceDashboardScroll(
  state: NavState,
  ctx: NavContext,
  frame: DashboardFrame,
  direction: -1 | 1
): ReducedNav {
  const paginated = ctx.dashboardPageCount(frame.hostId) > 1
  const bound = paginated ? ctx.dashboardPageCount(frame.hostId) : ctx.worktreeCount(frame.hostId)
  if (bound <= 0) {
    return unchanged(state)
  }
  const next = clamp(frame.page + direction, 0, bound - 1)
  if (next === frame.page) {
    return unchanged(state)
  }
  return { state: replaceTopFrame(state, { ...frame, page: next }), effects: NO_EFFECTS }
}

function reduceTerminalTailScroll(
  state: NavState,
  ctx: NavContext,
  frame: TerminalTailFrame,
  direction: -1 | 1
): ReducedNav {
  const pageCount = ctx.terminalTailPageCount(frame.terminalId)
  if (pageCount <= 0) {
    return unchanged(state)
  }
  const next = clamp(frame.page + direction, 0, pageCount - 1)
  if (next === frame.page) {
    return unchanged(state)
  }
  return { state: replaceTopFrame(state, { ...frame, page: next }), effects: NO_EFFECTS }
}

function reduceAskScroll(
  state: NavState,
  ctx: NavContext,
  frame: AskFrame,
  direction: -1 | 1
): ReducedNav {
  const optionCount = ctx.askOptionCount(frame.notificationId)
  const next = clampAskCursor(frame.selectedOption + direction, optionCount)
  if (next === frame.selectedOption) {
    return unchanged(state)
  }
  return { state: replaceTopFrame(state, { ...frame, selectedOption: next }), effects: NO_EFFECTS }
}

// --- click: a pending ask takes priority on any text screen (the header's own pulse says
// "click"); otherwise ask sends the highlighted answer and dashboard drills into a worktree. ---
function reduceClick(state: NavState, ctx: NavContext): ReducedNav {
  const frame = topFrame(state)

  if (frame.screen !== 'ask') {
    const hostId = frameHostId(frame)
    const notificationId = hostId === null ? null : ctx.pendingAskNotificationId(hostId)
    if (hostId !== null && notificationId !== null) {
      return {
        state: pushFrame(state, { screen: 'ask', hostId, notificationId, selectedOption: 0 }),
        effects: NO_EFFECTS
      }
    }
  }

  if (frame.screen === 'ask') {
    return reduceAskClick(state, ctx, frame)
  }
  if (frame.screen === 'dashboard') {
    return reduceDashboardClick(state, ctx, frame)
  }
  return unchanged(state)
}

function reduceAskClick(state: NavState, ctx: NavContext, frame: AskFrame): ReducedNav {
  const worktreeId = ctx.notificationWorktreeId(frame.notificationId)
  if (worktreeId === null) {
    return unchanged(state)
  }
  const option = resolveAskQuickAction(
    frame.selectedOption,
    ctx.askOptionCount(frame.notificationId)
  )
  return { state, effects: [{ kind: 'sendAskAnswer', hostId: frame.hostId, worktreeId, option }] }
}

function reduceDashboardClick(state: NavState, ctx: NavContext, frame: DashboardFrame): ReducedNav {
  if (ctx.dashboardPageCount(frame.hostId) > 1) {
    const next = pushFrame(state, {
      screen: 'worktreeList',
      hostId: frame.hostId,
      selectedIndex: 0,
      page: 0
    })
    return { state: next, effects: NO_EFFECTS }
  }
  const worktreeId = ctx.worktreeIdAt(frame.hostId, frame.page)
  if (worktreeId === null) {
    return unchanged(state)
  }
  const next = pushFrame(state, {
    screen: 'terminalTail',
    hostId: frame.hostId,
    worktreeId,
    terminalId: '',
    page: 0
  })
  return { state: next, effects: [{ kind: 'openTerminalTail', worktreeId }] }
}

// --- listSelect: click on a native list container. Index -1 (SDK quirk on item 0) falls back
// to the frame's own tracked selection. ---
function reduceListSelect(state: NavState, ctx: NavContext, rawIndex: number): ReducedNav {
  const frame = topFrame(state)
  if (frame.screen === 'hostList') {
    return reduceHostListSelect(state, ctx, frame, rawIndex)
  }
  if (frame.screen === 'worktreeList') {
    return reduceWorktreeListSelect(state, ctx, frame, rawIndex)
  }
  return unchanged(state)
}

function reduceHostListSelect(
  state: NavState,
  ctx: NavContext,
  frame: HostListFrame,
  rawIndex: number
): ReducedNav {
  const index = rawIndex === -1 ? frame.selectedIndex : rawIndex
  const tracked = replaceTopFrame(state, { ...frame, selectedIndex: index })
  const hostId = ctx.hostIdAt(index)
  if (hostId === null) {
    return { state: tracked, effects: NO_EFFECTS }
  }
  return {
    state: pushFrame(tracked, { screen: 'dashboard', hostId, page: 0 }),
    effects: [{ kind: 'connectHost', hostId }]
  }
}

function reduceWorktreeListSelect(
  state: NavState,
  ctx: NavContext,
  frame: WorktreeListFrame,
  rawIndex: number
): ReducedNav {
  const index = rawIndex === -1 ? frame.selectedIndex : rawIndex
  const tracked = replaceTopFrame(state, { ...frame, selectedIndex: index })
  const worktreeId = ctx.worktreeIdAt(frame.hostId, index)
  if (worktreeId === null) {
    return { state: tracked, effects: NO_EFFECTS }
  }
  const next = pushFrame(tracked, {
    screen: 'terminalTail',
    hostId: frame.hostId,
    worktreeId,
    terminalId: '',
    page: 0
  })
  return { state: next, effects: [{ kind: 'openTerminalTail', worktreeId }] }
}

// --- foreground/system/abnormal exit: exit-dialogue polarity inverts these while armed. ---
function reduceForegroundEnter(state: NavState): ReducedNav {
  if (state.exitDialogArmed) {
    return { state, effects: [{ kind: 'refreshDashboard' }] }
  }
  return { state, effects: [{ kind: 'resumePolling' }] }
}

function reduceForegroundExit(state: NavState): ReducedNav {
  if (state.exitDialogArmed) {
    return { state: { ...state, exitDialogArmed: false }, effects: [{ kind: 'resumePolling' }] }
  }
  return { state, effects: [{ kind: 'pausePolling' }] }
}

// Really exiting (spec S7): pause polling, close any open terminal tail, and — unlike
// abnormalExit, which keeps the session alive for reconnect — disconnect the host entirely.
function reduceSystemExit(state: NavState): ReducedNav {
  return {
    state: { ...state, exitDialogArmed: false },
    effects: [...teardownEffects(state), { kind: 'disconnectHost' }]
  }
}

function reduceAbnormalExit(state: NavState): ReducedNav {
  return { state, effects: teardownEffects(state) }
}

// No generic "close everything" effect exists (spec S7's NavEffect union); teardown is the
// closest reachable combination: pause polling, close any open terminal-tail subscription.
function teardownEffects(state: NavState): NavEffect[] {
  const effects: NavEffect[] = [{ kind: 'pausePolling' }]
  for (const frame of state.stack) {
    if (frame.screen === 'terminalTail' && frame.terminalId) {
      effects.push({ kind: 'closeTerminalTail', terminalId: frame.terminalId })
    }
  }
  return effects
}
