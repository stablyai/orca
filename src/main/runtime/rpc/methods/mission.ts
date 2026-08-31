import { homedir } from 'node:os'
import { z } from 'zod'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isTuiAgentEnabled,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../shared/tui-agent-selection'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  buildMissionPlanRepairPrompt,
  buildMissionPlanningPrompt,
  parseMissionPlan
} from '../../mission/mission-plan'
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
      const agents = await resolveMissionAgents(params.agent, settings)

      try {
        await runtime.showManagedTerminalWorkspace(params.worktree)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'selector_not_found') {
          throw error
        }
        throw new OrchestrationError(
          'selector_not_found',
          'Mission requires an Orca-managed workspace.'
        )
      }

      let lastPlannerError: OrchestrationError | null = null
      for (const [index, agent] of agents.entries()) {
        try {
          const planned = await planMissionWithAgent(params.text, agent, settings)
          return { ...planned, agentCandidates: agents.slice(index) }
        } catch (error) {
          if (
            params.agent ||
            !(error instanceof OrchestrationError) ||
            error.code !== 'mission_planner_failed'
          ) {
            throw error
          }
          lastPlannerError = error
        }
      }

      throw new OrchestrationError(
        'mission_planner_failed',
        `Mission planner failed for all available agents (${agents.join(', ')}): ${lastPlannerError?.message ?? 'unknown planner failure'}`
      )
    }
  })
]

async function planMissionWithAgent(
  mission: string,
  agent: TuiAgent,
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>
) {
  const plannerSpec = getCommitMessageAgentSpec(agent)
  if (!plannerSpec) {
    return { mission, agent, plan: { mode: 'single-agent' as const } }
  }

  const generationParams = {
    agentId: agent,
    model: plannerSpec.defaultModelId,
    agentCommandOverride: settings.agentCmdOverrides?.[agent]
  }
  const generationTarget = { kind: 'local' as const, cwd: homedir() }
  const generationOptions = { useAgentDefaultModel: true } as const
  const planning = await generateTextFromPrompt(
    buildMissionPlanningPrompt(mission),
    generationParams,
    generationTarget,
    'mission-plan',
    generationOptions
  )
  if (!planning.success) {
    throw new OrchestrationError('mission_planner_failed', planning.error)
  }

  try {
    return { mission, agent, plan: parseMissionPlan(planning.text) }
  } catch (error) {
    const validationError = error instanceof Error ? error.message : String(error)
    const repaired = await generateTextFromPrompt(
      buildMissionPlanRepairPrompt(mission, planning.text, validationError),
      generationParams,
      generationTarget,
      'mission-plan',
      generationOptions
    )
    if (!repaired.success) {
      throw new OrchestrationError('mission_planner_failed', repaired.error)
    }
    try {
      return { mission, agent, plan: parseMissionPlan(repaired.text) }
    } catch (repairError) {
      throw new OrchestrationError(
        'mission_planner_failed',
        repairError instanceof Error ? repairError.message : String(repairError)
      )
    }
  }
}

async function resolveMissionAgents(
  requested: TuiAgent | undefined,
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>
): Promise<TuiAgent[]> {
  if (requested) {
    if (!isTuiAgentEnabled(requested, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Mission agent ${requested} is disabled in Orca.`
      )
    }
    return [requested]
  }

  const candidates: TuiAgent[] = []
  const addCandidate = (value: unknown): void => {
    if (
      isTuiAgent(value) &&
      isTuiAgentEnabled(value, settings.disabledTuiAgents) &&
      !candidates.includes(value)
    ) {
      candidates.push(value)
    }
  }

  addCandidate(process.env.ORCA_MISSION_DEFAULT_AGENT)
  addCandidate(settings.defaultTuiAgent)

  const detected = new Set((await detectMissionAgents()).filter(isTuiAgent))
  for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
    if (detected.has(agent)) {
      addCandidate(agent)
    }
  }

  if (candidates.length === 0) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Mission requires an enabled default or detected agent in Orca.'
    )
  }
  return candidates
}

async function detectMissionAgents(): Promise<string[]> {
  try {
    return await detectInstalledAgentsWithShellPathHydration()
  } catch {
    return []
  }
}
