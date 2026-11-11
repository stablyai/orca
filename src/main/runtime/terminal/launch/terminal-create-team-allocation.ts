import { mergeTerminalEnvDeletionKeys } from './runtime-agent-launch-resolution'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { withAgentLaunchToken } from '../../../agent-launch/agent-launch-token'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { ClaudeAgentTeamsService } from '../agent-teams/claude-agent-teams-service'
import type { PtySpawnOutcome } from '../../../ipc/pty/spawn-outcome'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'

/** Only the exact allocation belongs to this start until the process accepts it. */
export function terminalCreateTeamAllocation(teams: ClaudeAgentTeamsService) {
  let teamId: string | undefined
  const release = () => {
    if (teamId) {
      teams.releaseTeam(teamId)
      teamId = undefined
    }
  }
  return {
    release,
    prepare: (
      args: Omit<Parameters<typeof buildRuntimeAgentTeamsLaunchPlan>[0], 'createTeamEnv'>,
      leaderHandle: string
    ) => {
      release()
      return buildRuntimeAgentTeamsLaunchPlan({
        ...args,
        createTeamEnv: (shimDir, shimBin) => {
          const allocation = teams.createLaunchEnv({
            leaderHandle,
            baseEnv: args.baseEnv,
            shimDir,
            shimBin
          })
          teamId = allocation.teamId
          return allocation.env
        }
      })
    },
    acceptOutcome: (outcome: PtySpawnOutcome) => {
      if (outcome.kind === 'committed' && !outcome.result.isReattach) {
        teamId = undefined
      }
    },
    acceptFresh: (
      result: Pick<PtySpawnOutcome['result'], 'agentSessionEnsure' | 'stablePaneOwner'>
    ) => {
      if (result.agentSessionEnsure?.disposition !== 'adopted' && !result.stablePaneOwner) {
        teamId = undefined
      }
    }
  }
}

export async function prepareTerminalCreateTeamLaunch({
  allocation,
  launchOpts,
  launchToken,
  preAllocatedHandle,
  teamsMode,
  releaseStablePaneCreate,
  buildEnv
}: {
  allocation: ReturnType<typeof terminalCreateTeamAllocation>
  launchOpts: TerminalCreateOptions
  launchToken: string | undefined
  preAllocatedHandle: string
  teamsMode: GlobalSettings['claudeAgentTeamsMode'] | undefined
  releaseStablePaneCreate: () => void
  buildEnv: (
    baseEnv: Record<string, string>,
    teamEnv: Record<string, string> | undefined
  ) => Record<string, string>
}) {
  const baseEnv = withAgentLaunchToken(launchOpts.env, launchToken)
  const agentTeams = await allocation
    .prepare(
      {
        launchConfig: launchOpts.launchConfig,
        command: launchOpts.command,
        claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
        claudeAgentTeamsMode: teamsMode,
        baseEnv: { ...process.env, ...baseEnv },
        adoptedBeforeLaunch: null
      },
      preAllocatedHandle
    )
    .catch((error: unknown) => {
      releaseStablePaneCreate()
      throw error
    })
  const { plan: agentTeamsPlan, sequencedStartupCommand } = agentTeams
  return {
    agentTeamsPlan,
    command: sequencedStartupCommand
      ? launchOpts.command
      : (agentTeamsPlan?.command ?? launchOpts.command),
    envToDelete: mergeTerminalEnvDeletionKeys(launchOpts.envToDelete, agentTeamsPlan?.envToDelete),
    launchConfig: agentTeams.effectiveLaunchConfig,
    env: buildEnv(
      {
        ...baseEnv,
        ...(sequencedStartupCommand
          ? { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
          : {})
      },
      agentTeamsPlan?.env
    )
  }
}
