// Contract module (Unit 0): pure navigation/input types from spec S7. Reducer logic
// (reduceHudInput) lands in Unit 5's hud-navigation.ts against these types; the normalizer
// producing HudInput values lands in Unit 2's glasses-event-normalization.ts.

export type HudInput =
  | { kind: 'click' }
  | { kind: 'doubleClick' }
  | { kind: 'scrollPrev' } // SCROLL_TOP
  | { kind: 'scrollNext' } // SCROLL_BOTTOM
  | { kind: 'listSelect'; index: number; label?: string } // click on a list container
  | { kind: 'foregroundEnter' }
  | { kind: 'foregroundExit' }
  | { kind: 'systemExit' }
  | { kind: 'abnormalExit' }

export type ScreenId =
  | 'pairing'
  | 'hostList'
  | 'dashboard'
  | 'worktreeList'
  | 'ask'
  | 'terminalTail'

export type ScreenFrame =
  | { screen: 'pairing' }
  | { screen: 'hostList'; selectedIndex: number }
  | { screen: 'dashboard'; hostId: string; page: number }
  | { screen: 'worktreeList'; hostId: string; selectedIndex: number; page: number }
  | { screen: 'ask'; hostId: string; notificationId: string; selectedOption: number }
  | { screen: 'terminalTail'; hostId: string; worktreeId: string; terminalId: string; page: number }

export type NavState = {
  stack: ScreenFrame[] // top = visible; bottom = root
  exitDialogArmed: boolean // shutDownPage(1) in flight - invert foreground events
}

export type AskQuickAction =
  | { kind: 'option'; digit: 1 | 2 | 3 | 4 } // send "<digit>\r"
  | { kind: 'enter' } // send "\r" (accept default)
  | { kind: 'escape' } // send "\x1b" (dismiss/deny)

export type NavEffect =
  | { kind: 'requestShutdownDialog' } // -> bridge.shutDownPage(1)
  | { kind: 'connectHost'; hostId: string }
  | { kind: 'openTerminalTail'; worktreeId: string } // resolve terminal + subscribe
  | { kind: 'closeTerminalTail'; terminalId: string }
  | { kind: 'sendAskAnswer'; hostId: string; worktreeId: string; option: AskQuickAction }
  | { kind: 'refreshDashboard' }
  | { kind: 'pausePolling' }
  | { kind: 'resumePolling' }
  // Integrator addition (spec S7: "systemExit = really exiting -> close sockets, unsubscribe").
  // Distinct from abnormalExit's teardown, which keeps the session alive for reconnect.
  | { kind: 'disconnectHost' }

// Read-only lookups reduceHudInput (Unit 5) needs to stay a pure function — supplied by
// hud-store selectors rather than reading HudState directly.
export type NavContext = {
  hostCount: number
  worktreeCount(hostId: string): number
  dashboardPageCount(hostId: string): number
  worktreeListPageCount(hostId: string): number
  terminalTailPageCount(terminalId: string): number
  pendingAskNotificationId(hostId: string): string | null
  askOptionCount(notificationId: string): number
  // Added by Unit 5 (hud-navigation.ts): resolves a list/cursor index to the real id an
  // effect or pushed ScreenFrame needs (connectHost/openTerminalTail require a concrete
  // hostId/worktreeId, not an index). Additive — no existing accessor's shape changed.
  hostIdAt(index: number): string | null
  worktreeIdAt(hostId: string, index: number): string | null
  notificationWorktreeId(notificationId: string): string | null
}
