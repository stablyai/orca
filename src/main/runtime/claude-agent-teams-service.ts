import { randomBytes, randomUUID } from 'node:crypto'
import { splitTmuxCommand } from '../../shared/claude-agent-teams-tmux-compat'
import { ClaudeAgentTeamsTmuxDispatcher } from './claude-agent-teams-tmux-dispatcher'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { resolveStartupShell, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'
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
  private readonly dispatcher = new ClaudeAgentTeamsTmuxDispatcher()

  createLaunchEnv(args: {
    leaderHandle: string
    baseEnv: Record<string, string | undefined>
    shimDir: string
    /** Absolute path only; null leaves the var unset so the shim refuses to guess a cwd-relative CLI. */
    shimBin: string | null
    /** Shell the teammate panes will type into; defaults to the platform's. */
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
      ORCA_AGENT_TEAMS_SHIM_DIR: args.shimDir
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
      teamId,
      token,
      leaderPane,
      leaderHandle: args.leaderHandle,
      paneShell: resolveStartupShell(process.platform, args.paneShell),
      sessionName: 'orca',
      windowIndex: '0',
      tmuxValue,
      baseEnv: env,
      panes: new Map([[leaderPane, leader]]),
      paneOrder: [leaderPane],
      nextPaneNumber: 2,
      mainVertical: null,
      previouslyFocusedPane: null,
      commandQueue: Promise.resolve()
    })
    return { teamId, token, leaderPane, env }
  }

  removeTeamForLeaderHandle(handle: string): void {
    for (const [teamId, team] of this.teams) {
      if (team.leaderHandle === handle) {
        this.teams.delete(teamId)
      }
    }
  }

  getActiveTeamCount(): number {
    return this.teams.size
  }

  async handleTmuxCompat(
    request: AgentTeamsTmuxCompatRequest,
    api: AgentTeamsTerminalApi
  ): Promise<AgentTeamsTmuxCompatResponse> {
    try {
      const team = this.resolveTeam(request)
      const { command, args } = splitTmuxCommand(request.argv)
      const stdout = await this.runSerialized(team, () =>
        this.dispatcher.dispatch(team, command, args, request.envPane, api)
      )
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: `tmux: ${message}\n`, exitCode: 1 }
    }
  }

  /**
   * Runs one tmux command at a time per team.
   *
   * Why: every shim invocation is its own process, so Claude Code launching a
   * whole team arrives as concurrent requests over separate connections. The
   * pane bookkeeping here is read-modify-write across awaits — `respawn-pane`
   * closes a pane's terminal before re-splitting from the pane it was split
   * from, and those origins chain — so an overlapping respawn reads an origin
   * handle whose terminal is already closed, its split throws, and the teammate
   * is dropped. A real tmux server answers one command at a time; matching that
   * is what keeps the bookkeeping consistent.
   */
  private runSerialized<T>(team: AgentTeam, run: () => Promise<T>): Promise<T> {
    const result = team.commandQueue.then(run)
    // Why swallow: the queue only orders commands, so one command's failure
    // must not reject every command queued behind it.
    team.commandQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private resolveTeam(request: AgentTeamsTmuxCompatRequest): AgentTeam {
    const team = this.teams.get(request.teamId)
    if (!team || team.token !== request.token) {
      throw new Error('stale or unauthorized agent team')
    }
    if (!team.panes.has(request.envPane)) {
      throw new Error(`unknown pane: ${request.envPane}`)
    }
    return team
  }
}
