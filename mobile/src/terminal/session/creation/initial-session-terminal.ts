export type InitialSessionTerminalAutoCreateInput = {
  newlyCreatedWorkspace: boolean
  connected: boolean
  tabsLoaded: boolean
  visibleTabCount: number
  hasActiveTerminalHandle: boolean
  createInFlight: boolean
  sawSessionTabs: boolean
  autoCreatedForWorktree: boolean
}

// Only an always-empty newly created workspace auto-creates: once tabs existed, later emptiness may be an intentional close and must not resurrect a terminal.
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
