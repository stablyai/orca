import type {
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
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
  readTerminal(handle: string, opts?: { limit?: number }): Promise<RuntimeTerminalRead>
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
