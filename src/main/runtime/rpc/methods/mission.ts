import { homedir } from 'node:os'
import { z } from 'zod'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../../shared/tui-agent-selection'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildMissionPlanningPrompt, parseMissionPlan } from '../../mission/mission-plan'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const MissionPlanParams = z.object({
  text: requiredString('Missing mission text'),
  worktree: requiredString('Mission requires an Orca workspace'),
  agent: z
    .custom<TuiAgent>((value) => isTuiAgent(value), { message: 'Invalid mission agent' })
    .optional()
})

export const MISSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'mission.plan',
    params: MissionPlanParams,
    handler: async (params, { runtime }) => {
      const settings = runtime.getClientSettings()
      const agent = await resolveMissionAgent(params.agent, settings)

      try {
        await runtime.showManagedTerminalWorkspace(params.worktree)
      } catch {
        throw new OrchestrationError(
          'selector_not_found',
          'Mission requires an Orca-managed workspace.'
        )
      }

      const plannerSpec = getCommitMessageAgentSpec(agent)
      if (!plannerSpec) {
        return {
          mission: params.text,
          agent,
          plan: { mode: 'single-agent' as const }
        }
      }

      const planning = await generateTextFromPrompt(
        buildMissionPlanningPrompt(params.text),
        {
          agentId: agent,
          model: plannerSpec.defaultModelId,
          agentCommandOverride: settings.agentCmdOverrides?.[agent]
        },
        { kind: 'local', cwd: homedir() },
        'mission-plan',
        { useAgentDefaultModel: true }
      )
      if (!planning.success) {
        throw new OrchestrationError('mission_planner_failed', planning.error)
      }

      try {
        return {
          mission: params.text,
          agent,
          plan: parseMissionPlan(planning.text)
        }
      } catch (error) {
        throw new OrchestrationError(
          'mission_planner_failed',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  })
]

async function resolveMissionAgent(
  requested: TuiAgent | undefined,
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>
): Promise<TuiAgent> {
  if (requested) {
    if (!isTuiAgentEnabled(requested, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Mission agent ${requested} is disabled in Orca.`
      )
    }
    return requested
  }

  const localPreferred = process.env.ORCA_MISSION_DEFAULT_AGENT
  if (isTuiAgent(localPreferred) && isTuiAgentEnabled(localPreferred, settings.disabledTuiAgents)) {
    const detected = await detectMissionAgents()
    if (detected.includes(localPreferred)) {
      return localPreferred
    }
  }

  const preferred = settings.defaultTuiAgent
  if (isTuiAgent(preferred) && isTuiAgentEnabled(preferred, settings.disabledTuiAgents)) {
    return preferred
  }

  const picked = pickTuiAgent(
    null,
    (await detectMissionAgents()).filter(isTuiAgent),
    settings.disabledTuiAgents
  )
  if (!picked) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Mission requires an enabled default or detected agent in Orca.'
    )
  }
  return picked
}

async function detectMissionAgents(): Promise<string[]> {
  try {
    return await detectInstalledAgentsWithShellPathHydration()
  } catch {
    return []
  }
}
