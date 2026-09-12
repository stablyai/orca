// Mirrors the desktop `shouldAutoCreateInitialTerminal` gate: a newly created
// workspace that hydrates empty gets one terminal so the session isn't blank.
// Kept pure (no react-native imports) so the gate is unit-testable.

export type InitialSessionTerminalAutoCreateInput = {
  /** Navigation came directly from creating this workspace. */
  newlyCreatedWorkspace: boolean
  /** Host connection is up and an RPC client is attached. */
  connected: boolean
  /** At least one session-tab snapshot has been applied on this route. */
  tabsLoaded: boolean
  /** Session tabs currently rendered on the phone. */
  visibleTabCount: number
  /** A terminal is still streaming even though the tab list reads empty. */
  hasActiveTerminalHandle: boolean
  /** A terminal, browser, or markdown create is already in flight. */
  createInFlight: boolean
  /** This route has shown at least one session tab for this workspace. */
  sawSessionTabs: boolean
  /** This route already auto-created a terminal for this workspace. */
  autoCreatedForWorktree: boolean
}

/**
 * Whether to auto-create the first terminal of a newly created mobile session.
 *
 * `sawSessionTabs` is the resurrection guard: emptiness that *follows* a
 * populated tab list was produced by a close (the user's, or the host dropping
 * a dead pane), and re-creating there spawns a brand-new terminal the user
 * never asked for — issues #9717 / #7345. Only a workspace that has shown
 * nothing since its creation route opened is eligible.
 */
export function shouldAutoCreateInitialSessionTerminal(
  input: InitialSessionTerminalAutoCreateInput
): boolean {
  if (!input.newlyCreatedWorkspace || !input.connected || !input.tabsLoaded) {
    return false
  }
  if (input.visibleTabCount > 0 || input.hasActiveTerminalHandle) {
    return false
  }
  if (input.createInFlight || input.autoCreatedForWorktree) {
    return false
  }
  return !input.sawSessionTabs
}
