import type { DashboardCardTerminalInput } from '../../shared/dashboard-snapshot'

export type DetachedTerminalOpenArgs = {
  tabId: string
  ptyId: string
  title: string
}

export type DetachedTerminalApi = {
  open: (args: DetachedTerminalOpenArgs) => Promise<boolean>
  close: (tabId: string) => Promise<void>
  returnToMain: (tabId: string) => Promise<void>
  onClosed: (callback: (tabId: string) => void) => () => void
  setTerminalInput: (
    tabId: string,
    terminalInput: DashboardCardTerminalInput | null
  ) => Promise<void>
  /** Undefined until the main renderer has sent the pane's facts. */
  getTerminalInput: (tabId: string) => Promise<DashboardCardTerminalInput | null | undefined>
  onTerminalInput: (
    callback: (terminalInput: DashboardCardTerminalInput | null) => void
  ) => () => void
}
