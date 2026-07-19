import type {
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
  RuntimeTerminalReadSource,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit
} from '../../shared/runtime-types'

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
    }
  ): Promise<RuntimeTerminalSplit>
  readTerminal(
    handle: string,
    opts?: { limit?: number; source?: RuntimeTerminalReadSource }
  ): Promise<RuntimeTerminalRead>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean }
  ): Promise<RuntimeTerminalSend>
  focusTerminal(handle: string): Promise<RuntimeTerminalFocus>
  closeTerminal(handle: string): Promise<RuntimeTerminalClose>
  showTerminal(handle: string): Promise<RuntimeTerminalShow>
}

export type TeamPane = {
  fakePaneId: string
  handle: string
  index: number
  // Why: Claude Code splits a holding pane (`-- cat`) then `respawn-pane`s it
  // with the real teammate command. We remember how the pane was first split so
  // respawn can recreate it in the same slot while preserving its fake pane id.
  splitFromPane?: string
  splitDirection?: 'horizontal' | 'vertical'
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
  paneOrder: string[]
  nextPaneNumber: number
  mainVertical: {
    mainPane: string
    lastColumnPane: string | null
  } | null
  previouslyFocusedPane: string | null
}
