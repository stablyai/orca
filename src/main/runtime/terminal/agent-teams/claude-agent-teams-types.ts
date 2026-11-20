import type {
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
  RuntimeTerminalShow,
  RuntimeTerminalSplit
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimeTerminalSend } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'

export type AgentTeamsTmuxCompatRequest = {
  teamId: string
  token: string
  envPane: string
  cwd?: string
  argv: string[]
}

export type AgentTeamsTmuxCompatResponse = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export type AgentTeamsLaunchEnv = {
  teamId: string
  token: string
  leaderPane: string
  env: Record<string, string>
}

export type AgentTeamsTerminalApi = {
  splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      preAllocatedHandle?: string
    }
  ): Promise<RuntimeTerminalSplit>
  /** A handle for a terminal not started yet, so the team holds it from its first moment. */
  allocateTerminalHandle(): string
  readTerminal(handle: string, opts?: { limit?: number }): Promise<RuntimeTerminalRead>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: { inputKind: TerminalInputKind }
  ): Promise<RuntimeTerminalSend>
  focusTerminal(handle: string): Promise<RuntimeTerminalFocus>
  closeTerminal(handle: string): Promise<RuntimeTerminalClose>
  showTerminal(handle: string): Promise<RuntimeTerminalShow>
}

export type TeamPane = {
  fakePaneId: string
  handle: string
  index: number
  // Remember the split slot so placeholder respawn can preserve its fake pane id.
  splitFromPane?: string
  splitDirection?: 'horizontal' | 'vertical'
  respawnBlockedReason?: string
}

export type AgentTeam = {
  teamId: string
  token: string
  leaderPane: string
  leaderHandle: string
  sessionName: string
  windowIndex: string
  tmuxValue: string
  baseEnv: Record<string, string>
  panes: Map<string, TeamPane>
  /** Handles of teammates whose split is still starting; they belong to the team already. */
  startingHandles: Set<string>
  paneOrder: string[]
  nextPaneNumber: number
  mainVertical: {
    mainPane: string
    lastColumnPane: string | null
  } | null
  previouslyFocusedPane: string | null
}
