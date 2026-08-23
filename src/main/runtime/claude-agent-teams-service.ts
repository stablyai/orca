import { randomBytes, randomUUID } from 'node:crypto'
import { splitTmuxCommand } from '../../shared/claude-agent-teams-tmux-compat'
import { ClaudeAgentTeamsTmuxDispatcher } from './claude-agent-teams-tmux-dispatcher'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { removePaneFromLayout } from './claude-agent-teams-pane-layout'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type {
  AgentTeam,
  AgentTeamsLaunchEnv,
  AgentTeamsTerminalApi,
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse,
  TeamPane
} from './claude-agent-teams-types'

export type {
  AgentTeamsLaunchEnv,
  AgentTeamsTerminalApi,
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-types'

export class ClaudeAgentTeamsService {
  private readonly teams = new Map<string, AgentTeam>()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly exitedTerminalHandles = new Set<string>()
  private readonly dispatcher = new ClaudeAgentTeamsTmuxDispatcher()

  createLaunchEnv(args: {
    leaderHandle: string
    baseEnv: Record<string, string | undefined>
    shimDir: string
    /** Absolute path only; null leaves the var unset so the shim refuses to guess a cwd-relative CLI. */
    shimBin: string | null
    shimEnv?: Record<string, string>
    paneShell?: AgentStartupShell
  }): AgentTeamsLaunchEnv {
    const teamId = `team-${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const leaderPane = '%1'
    // Why: Windows callers pass an env spelt `Path`; reading `PATH` there truncated the launch PATH to just the shim dir.
    const pathKey = resolvePathEnvKey(args.baseEnv, process.platform)
    const pathValue = [args.shimDir, args.baseEnv[pathKey]]
      .filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ':')
    const tmuxValue = `/tmp/orca-claude-agent-teams/${teamId},0,1`
    const env: Record<string, string> = {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      [pathKey]: pathValue,
      TMUX: tmuxValue,
      TMUX_PANE: leaderPane,
      TERM: 'screen-256color',
      COLORTERM: args.baseEnv.COLORTERM || 'truecolor',
      ORCA_AGENT_TEAMS_TEAM_ID: teamId,
      ORCA_AGENT_TEAMS_TOKEN: token,
      ORCA_AGENT_TEAMS_LEADER_PANE: leaderPane,
      ORCA_AGENT_TEAMS_SHIM_DIR: args.shimDir,
      ...args.shimEnv
    }
    if (args.shimBin) {
      env.ORCA_AGENT_TEAMS_SHIM_BIN = args.shimBin
    }
    if (args.baseEnv.ORCA_PAIRING_CODE) {
      env.ORCA_PAIRING_CODE = args.baseEnv.ORCA_PAIRING_CODE
    }
    if (args.baseEnv.ORCA_ENVIRONMENT) {
      env.ORCA_ENVIRONMENT = args.baseEnv.ORCA_ENVIRONMENT
    }

    const leader: TeamPane = { fakePaneId: leaderPane, handle: args.leaderHandle, index: 0 }
    this.teams.set(teamId, {
      active: true,
      abortController: new AbortController(),
      teamId,
      token,
      leaderPane,
      leaderHandle: args.leaderHandle,
      sessionName: 'orca',
      windowIndex: '0',
      tmuxValue,
      baseEnv: env,
      paneShell: args.paneShell ?? (process.platform === 'win32' ? 'powershell' : 'posix'),
      panes: new Map([[leaderPane, leader]]),
      paneOrder: [leaderPane],
      nextPaneNumber: 2,
      mainVertical: null,
      previouslyFocusedPane: null
    })
    return { teamId, token, leaderPane, env }
  }

  removeTeamForLeaderHandle(handle: string): void {
    for (const [teamId, team] of this.teams) {
      if (team.leaderHandle === handle) {
        team.active = false
        team.abortController.abort()
        if (!this.operationTails.has(teamId)) {
          this.teams.delete(teamId)
        }
      }
    }
  }

  getActiveTeamCount(): number {
    return [...this.teams.values()].filter((team) => team.active).length
  }

  onTerminalExited(handle: string): void {
    this.exitedTerminalHandles.add(handle)
    const cleanupOperations: Promise<unknown>[] = []
    for (const team of this.teams.values()) {
      if (team.leaderHandle === handle) {
        this.removeTeamForLeaderHandle(handle)
        continue
      }
      cleanupOperations.push(
        this.runSerialized(team, async () => {
          const pane = [...team.panes.values()].find(
            (candidate) => candidate.handle === handle && candidate.fakePaneId !== team.leaderPane
          )
          if (pane) {
            removePaneFromLayout(team, pane)
          }
        })
      )
    }
    void Promise.allSettled(cleanupOperations).then(() => {
      this.exitedTerminalHandles.delete(handle)
    })
  }

  async handleTmuxCompat(
    request: AgentTeamsTmuxCompatRequest,
    api: AgentTeamsTerminalApi
  ): Promise<AgentTeamsTmuxCompatResponse> {
    try {
      const team = this.resolveTeam(request)
      const { command, args } = splitTmuxCommand(request.argv)
      const stdout = await this.runSerialized(team, async () =>
        this.dispatcher.dispatch(
          team,
          command,
          args,
          request.envPane,
          this.guardTerminalApi(team, api)
        )
      )
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: `tmux: ${message}\n`, exitCode: 1 }
    }
  }

  private resolveTeam(request: AgentTeamsTmuxCompatRequest): AgentTeam {
    const team = this.teams.get(request.teamId)
    if (!team?.active || team.token !== request.token) {
      throw new Error('stale or unauthorized agent team')
    }
    if (!team.panes.has(request.envPane)) {
      throw new Error(`unknown pane: ${request.envPane}`)
    }
    return team
  }

  private async runSerialized<T>(team: AgentTeam, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(team.teamId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.operationTails.set(team.teamId, tail)
    await previous
    try {
      this.assertActive(team)
      return await operation()
    } finally {
      release()
      if (this.operationTails.get(team.teamId) === tail) {
        this.operationTails.delete(team.teamId)
      }
      if (!team.active) {
        this.teams.delete(team.teamId)
      }
    }
  }

  private guardTerminalApi(team: AgentTeam, api: AgentTeamsTerminalApi): AgentTeamsTerminalApi {
    return {
      ...api,
      splitTerminal: async (handle, opts) => {
        this.assertActive(team)
        const split = await api.splitTerminal(handle, {
          ...opts,
          signal: team.abortController.signal
        })
        await this.commitSplitTerminal(team, api, split.handle)
        return split
      }
    }
  }

  private async commitSplitTerminal(
    team: AgentTeam,
    api: AgentTeamsTerminalApi,
    handle: string
  ): Promise<void> {
    try {
      this.assertActive(team)
      if (this.exitedTerminalHandles.delete(handle)) {
        throw new Error('terminal_exited')
      }
      api.admitTerminal?.(handle)
    } catch (error) {
      const close = await api.closeTerminal(handle)
      if (!close.ptyKilled) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${reason}; rejected pane stop ${close.ptyStopVerdict ?? 'unverifiable'}`)
      }
      throw error
    }
  }

  private assertActive(team: AgentTeam): void {
    if (!team.active) {
      throw new Error('stale or unauthorized agent team')
    }
  }
}
