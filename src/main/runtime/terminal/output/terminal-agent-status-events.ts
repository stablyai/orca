import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'

export type RuntimeTerminalAgentStatusEvent = {
  ptyId: string
  source: 'mounted-leaf' | 'pty-record'
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  /** Persist live terminal handle so readers can rejoin after pane-key movement. */
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
  /** Set by the process-lifetime producer; see AgentHookServer.ingestTerminalStatus. */
  origin?: 'process'
  yieldsToHookSince?: number
  /** Projected from OSC 7501; the store applies it only where hooks do not speak for the pane. */
  fromProgramStatus?: true
  /** The program left no records, so a row it owns is removed rather than written. */
  removesProgramStatusRow?: true
  /** A repeat of the program's live report that renews its row's freshness lease. */
  renewsProgramStatusLease?: true
}

/** A pane's OSC 7501 facet changed. `facet: null` means the program's root record is gone. */
export type RuntimeTerminalProgramStatusFacetEvent = {
  ptyId: string
  paneKey: string
  facet: ProgramStatusFacet | null
}
