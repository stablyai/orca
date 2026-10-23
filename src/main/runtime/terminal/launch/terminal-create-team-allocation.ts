import type { ClaudeAgentTeamsService } from '../../claude-agent-teams-service'
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
