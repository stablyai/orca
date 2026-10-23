import { randomBytes, randomUUID } from 'node:crypto'
import { it2SessionIdForPane, parseIt2Command } from '../../shared/claude-agent-teams-it2-compat'
import { splitTmuxCommand } from '../../shared/claude-agent-teams-tmux-compat'
import { ClaudeAgentTeamsIt2Dispatcher } from './claude-agent-teams-it2-dispatcher'
import { ClaudeAgentTeamsTmuxDispatcher } from './claude-agent-teams-tmux-dispatcher'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import type {
  AgentTeam,
  AgentTeamsIt2CompatRequest,
  AgentTeamsIt2CompatResponse,
  AgentTeamsLaunchEnv,
  AgentTeamsTerminalApi,
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse,
  ClaudeAgentTeamsIt2Shim,
  TeamPane
} from './claude-agent-teams-types'

export class ClaudeAgentTeamsService {
  private readonly teams = new Map<string, AgentTeam>()
  private readonly dispatcher = new ClaudeAgentTeamsTmuxDispatcher()
  private readonly it2Dispatcher = new ClaudeAgentTeamsIt2Dispatcher()

  createLaunchEnv(args: {
    leaderHandle: string
    baseEnv: Record<string, string | undefined>
    shimDir: string
    /** Absolute path only; null leaves the var unset so the shim refuses to guess a cwd-relative CLI. */
    shimBin: string | null
    it2?: ClaudeAgentTeamsIt2Shim
  }): AgentTeamsLaunchEnv {
    const teamId = `team-${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const leaderPane = '%1'
    // Why: Windows callers pass an env spelt `Path`; reading `PATH` there truncated the launch PATH to just the shim dir.
    const pathKey = resolvePathEnvKey(args.baseEnv, process.platform)
    const pathSeparator = process.platform === 'win32' ? ';' : ':'
    const pathValue = [args.shimDir, args.baseEnv[pathKey]].filter(Boolean).join(pathSeparator)
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
      sessionName: 'orca',
      windowIndex: '0',
      tmuxValue,
      baseEnv: env,
      panes: new Map([[leaderPane, leader]]),
      paneOrder: [leaderPane],
      nextPaneNumber: 2,
      mainVertical: null,
      previouslyFocusedPane: null
    })
    if (!args.it2) {
      return { teamId, token, leaderPane, env }
    }
    // Why: only the leader Claude may see the iTerm2 identity; teammate panes inherit team.baseEnv and must not.
    const leaderEnv = {
      ...env,
      [pathKey]: [args.it2.shimDir, pathValue].join(pathSeparator),
      ITERM_SESSION_ID: `w0t0p0:${it2SessionIdForPane(leaderPane)}`,
      ORCA_AGENT_TEAMS_IT2_SHIM_DIR: args.it2.shimDir,
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: args.it2.probeShell
    }
    return { teamId, token, leaderPane, env: leaderEnv }
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
      if (!team.panes.has(request.envPane)) {
        throw new Error(`unknown pane: ${request.envPane}`)
      }
      const { command, args } = splitTmuxCommand(request.argv)
      const stdout = await this.dispatcher.dispatch(team, command, args, request.envPane, api)
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: `tmux: ${message}\n`, exitCode: 1 }
    }
  }

  async handleIt2Compat(
    request: AgentTeamsIt2CompatRequest,
    api: AgentTeamsTerminalApi
  ): Promise<AgentTeamsIt2CompatResponse> {
    try {
      const team = this.resolveTeam(request)
      const stdout = await this.it2Dispatcher.dispatch(team, parseIt2Command(request.argv), api)
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: `it2: ${message}\n`, exitCode: 1 }
    }
  }

  private resolveTeam(request: { teamId: string; token: string }): AgentTeam {
    const team = this.teams.get(request.teamId)
    if (!team || team.token !== request.token) {
      throw new Error('stale or unauthorized agent team')
    }
    return team
  }
}
