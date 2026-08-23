import type {
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit
} from '../../shared/runtime-types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { ClaudeAgentTeamsPaneSpawn } from '../../shared/claude-agent-teams-pane-launch'

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
  /** Service-owned synchronous commit fence; dispatchers never publish before it succeeds. */
  admitTerminal?(handle: string): void
  splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      cwd?: string
      env?: Record<string, string>
      agentTeamsProcess?: ClaudeAgentTeamsPaneSpawn['process']
      signal?: AbortSignal
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
  handle: string | null
  index: number
  // Why: Claude's holding `cat` pane stays virtual until respawn supplies the real process.
  splitFromPane?: string
  splitDirection?: 'horizontal' | 'vertical'
  respawnBlockedReason?: string
}

export type AgentTeam = {
  active: boolean
  abortController: AbortController
  teamId: string
  token: string
  leaderPane: string
  leaderHandle: string
  sessionName: string
  windowIndex: string
  tmuxValue: string
  baseEnv: Record<string, string>
  paneShell: AgentStartupShell
  panes: Map<string, TeamPane>
  paneOrder: string[]
  nextPaneNumber: number
  mainVertical: {
    mainPane: string
    lastColumnPane: string | null
  } | null
  previouslyFocusedPane: string | null
}
