import type { ParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'

export type TerminalStatusIngestEvent = {
  ptyId?: string
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
  /** `process`: derived from the pane's foreground process rather than parsed from its bytes. */
  origin?: 'process'
  /** Drop this write when a hook has reported the pane since then (the hook owns that command). */
  yieldsToHookSince?: number
  /** Projected from OSC 7501: yields to the pane's hook row (programStatusHookYieldEndsAt). */
  fromProgramStatus?: true
  /** The program left no records: a row only OSC wrote is removed instead. */
  removesProgramStatusRow?: true
  /** A repeat that renews a live program row's freshness; the window must see it too. */
  renewsProgramStatusLease?: true
  /** Deferred precedence re-offers must not invent producer activity. */
  isReplay?: true
}
