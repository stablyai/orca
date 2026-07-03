import { randomBytes, randomUUID } from 'node:crypto'
import { splitTmuxCommand } from '../../shared/claude-agent-teams-tmux-compat'
import { ClaudeAgentTeamsTmuxDispatcher } from './claude-agent-teams-tmux-dispatcher'
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
    shimBin: string
  }): AgentTeamsLaunchEnv {
    const teamId = `team-${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const leaderPane = '%1'
    const pathValue = [args.shimDir, args.baseEnv.PATH]
      .filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ':')
    const tmuxValue = `/tmp/orca-claude-agent-teams/${teamId},0,1`
    const env: Record<string, string> = {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      PATH: pathValue,
      TMUX: tmuxValue,
      TMUX_PANE: leaderPane,
      TERM: 'screen-256color',
      COLORTERM: args.baseEnv.COLORTERM || 'truecolor',
      ORCA_AGENT_TEAMS_TEAM_ID: teamId,
      ORCA_AGENT_TEAMS_TOKEN: token,
      ORCA_AGENT_TEAMS_LEADER_PANE: leaderPane,
      ORCA_AGENT_TEAMS_SHIM_DIR: args.shimDir,
      ORCA_AGENT_TEAMS_SHIM_BIN: args.shimBin
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
      const stdout = await this.dispatcher.dispatch(team, command, args, request.envPane, api)
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: `tmux: ${message}\n`, exitCode: 1 }
    }
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
