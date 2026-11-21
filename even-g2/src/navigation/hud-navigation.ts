// Unit 5: pure navigation reducer (spec S7). No bridge/transport imports — reduceHudInput is
// (NavState, HudInput, NavContext) -> { state, effects }, fully unit-testable in isolation.
import type { HudInput, NavContext, NavEffect, NavState, ScreenFrame } from './nav-contract'
import { clampAskCursor, resolveAskQuickAction } from './ask-quick-action'
import {
  clampToRange as clamp,
  frameHostId,
  isListLayoutScreen,
  isRootFrame,
  NO_EFFECTS,
  popFrame,
  pushFrame,
  type ReducedNav,
  replaceTopFrame,
  topFrame,
  unchangedNav as unchanged
} from './hud-navigation-frames'
import { reduceDashboardClick, reduceDashboardScroll } from './hud-navigation-dashboard'
import {
  reduceHostListSelect,
  reduceWorktreeListScroll,
  reduceWorktreeListSelect
} from './hud-navigation-list-select'

export { createInitialNavState } from './hud-navigation-frames'
export type { ReducedNav } from './hud-navigation-frames'

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
      return reduceListSelect(state, ctx, input.index, input.label)
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

// --- scroll: hostList never paginates so it's a no-op (firmware scrolls natively);
// worktreeList's native scrolling is also free within a page, but SCROLL_TOP/BOTTOM fire when
// the user hits the very top/bottom of the current ≤20-item window, so those boundary hits
// must turn our own page; text layouts page-turn or move a cursor depending on the screen. ---
function reduceScroll(state: NavState, ctx: NavContext, direction: -1 | 1): ReducedNav {
  const frame = topFrame(state)
  if (frame.screen === 'worktreeList') {
    return reduceWorktreeListScroll(state, ctx, frame, direction)
  }
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

type TerminalTailFrame = Extract<ScreenFrame, { screen: 'terminalTail' }>
type AskFrame = Extract<ScreenFrame, { screen: 'ask' }>

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

// --- click: a pending ask takes priority on any screen — text or native list (finding #7's
// worktreeList fix shares this via reduceListSelect below) — the header's own pulse says
// "click"; otherwise ask sends the highlighted answer and dashboard drills into a worktree. ---
function reduceClick(state: NavState, ctx: NavContext): ReducedNav {
  const frame = topFrame(state)

  if (frame.screen !== 'ask') {
    const hostId = frameHostId(frame)
    const notificationId = hostId === null ? null : ctx.pendingAskNotificationId(hostId)
    if (hostId !== null && notificationId !== null) {
      return pushAskFrame(state, hostId, notificationId)
    }
  }

  if (frame.screen === 'ask') {
    return reduceAskClick(state, ctx, frame)
  }
  if (frame.screen === 'dashboard') {
    return reduceDashboardClick(state, ctx, frame)
  }
  // terminalTail: `page` is an offset-from-latest (0 = live edge); a click jumps back to latest
  // (finding #8's "click=latest"). No-op when already following the live edge.
  if (frame.screen === 'terminalTail' && frame.page !== 0) {
    return { state: replaceTopFrame(state, { ...frame, page: 0 }), effects: NO_EFFECTS }
  }
  return unchanged(state)
}

function pushAskFrame(state: NavState, hostId: string, notificationId: string): ReducedNav {
  return {
    state: pushFrame(state, { screen: 'ask', hostId, notificationId, selectedOption: 0 }),
    effects: NO_EFFECTS
  }
}

function reduceAskClick(state: NavState, ctx: NavContext, frame: AskFrame): ReducedNav {
  const worktreeId = ctx.notificationWorktreeId(frame.notificationId)
  if (worktreeId === null) {
    return unchanged(state)
  }
  // CRITICAL #11: ignore the click rather than emit a second sendAskAnswer for the SAME prompt
  // while one is already in flight, or while its last attempt's outcome is still unknown (HIGH
  // #3: scoped by notificationId, not worktreeId, so a genuinely new episode is never stuck).
  if (ctx.askSendInFlight(frame.notificationId)) {
    return unchanged(state)
  }
  const option = resolveAskQuickAction(
    frame.selectedOption,
    ctx.askOptionCount(frame.notificationId)
  )
  return {
    state,
    effects: [
      {
        kind: 'sendAskAnswer',
        hostId: frame.hostId,
        worktreeId,
        notificationId: frame.notificationId,
        option
      }
    ]
  }
}

// --- listSelect: click on a native list container. ---
function reduceListSelect(
  state: NavState,
  ctx: NavContext,
  rawIndex: number,
  label: string | undefined
): ReducedNav {
  const frame = topFrame(state)
  if (frame.screen === 'hostList') {
    return reduceHostListSelect(state, ctx, frame, rawIndex, label)
  }
  if (frame.screen === 'worktreeList') {
    // HIGH #7: a pending ask must win over the row the wearer happened to tap, same as the
    // dashboard's plain-click priority above — otherwise the header's "needs input — click"
    // nudge is a lie on this screen (the tap opens whatever worktree row was under the finger).
    const notificationId = ctx.pendingAskNotificationId(frame.hostId)
    if (notificationId !== null) {
      return pushAskFrame(state, frame.hostId, notificationId)
    }
    return reduceWorktreeListSelect(state, ctx, frame, rawIndex, label)
  }
  return unchanged(state)
}

// --- foreground/system/abnormal exit: exit-dialogue polarity inverts these while armed. ---
function reduceForegroundEnter(state: NavState): ReducedNav {
  if (state.exitDialogArmed) {
    // Firmware clears the page to show the confirm dialogue; invalidate the render queue's
    // remembered previous page so whatever gets submitted next — now, or once the user
    // answers — forces a rebuild instead of being diffed as a no-op against stale memory
    // (spec: "host cleared the page -> effect refreshDashboard + re-render (rebuild) cue").
    return { state, effects: [{ kind: 'refreshDashboard' }, { kind: 'invalidateRender' }] }
  }
  if (state.terminalTailsNeedReopen) {
    const reopenEffects: NavEffect[] = terminalTailFrames(state).map((frame) => ({
      kind: 'reopenTerminalTail',
      worktreeId: frame.worktreeId
    }))
    return {
      state: { ...state, terminalTailsNeedReopen: false },
      effects: [{ kind: 'resumePolling' }, ...reopenEffects]
    }
  }
  return { state, effects: [{ kind: 'resumePolling' }] }
}

function reduceForegroundExit(state: NavState): ReducedNav {
  if (state.exitDialogArmed) {
    // "No" dismisses the dialogue; firmware leaves the page blank (it was cleared to show the
    // dialogue and is not restored). invalidateRender forces the queue to rebuild the current
    // screen now so the HUD un-blanks (finding hud-navigation.ts:264).
    return {
      state: { ...state, exitDialogArmed: false },
      effects: [{ kind: 'invalidateRender' }, { kind: 'resumePolling' }]
    }
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

// abnormalExit tears down subscriptions but keeps the terminalTail frame(s) on the stack (spec:
// "reconnect on next foregroundEnter"); mark them as needing re-subscription so the next
// non-armed foregroundEnter can reopen them instead of leaving a still-visible frame
// permanently disconnected.
function reduceAbnormalExit(state: NavState): ReducedNav {
  const needsReopen = terminalTailFrames(state).length > 0
  return {
    state: needsReopen ? { ...state, terminalTailsNeedReopen: true } : state,
    effects: teardownEffects(state)
  }
}

function terminalTailFrames(state: NavState): TerminalTailFrame[] {
  return state.stack.filter((frame): frame is TerminalTailFrame => frame.screen === 'terminalTail')
}

// No generic "close everything" effect exists (spec S7's NavEffect union); teardown is the
// closest reachable combination: pause polling, close any open terminal-tail subscription.
function teardownEffects(state: NavState): NavEffect[] {
  const effects: NavEffect[] = [{ kind: 'pausePolling' }]
  for (const frame of terminalTailFrames(state)) {
    if (frame.terminalId) {
      effects.push({ kind: 'closeTerminalTail', terminalId: frame.terminalId })
    }
  }
  return effects
}
