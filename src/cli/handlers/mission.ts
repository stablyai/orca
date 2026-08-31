import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector } from '../selectors'
import {
  formatMissionAttention,
  type MissionAttention
} from './mission/mission-attention-reporting'
import {
  executeMissionRun,
  type MissionPlanRpcResult,
  type MissionTask
} from './mission/mission-supervisor'
import { acquireMissionCoordinator } from './mission/mission-coordinator'
import { manageMissionCoordinator } from './mission/mission-coordinator-lifecycle'
import { MissionWorkerStartFailure } from './mission/mission-start-failure'

export const MISSION_HANDLERS: Record<string, CommandHandler> = {
  'mission start': async ({ flags, client, cwd, json }) => {
    const mission = getRequiredStringFlag(flags, 'text')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    if (!worktree) {
      throw new RuntimeClientError(
        'selector_not_found',
        'orca-sub requires an Orca-managed workspace. Run it inside a managed workspace or pass --worktree.'
      )
    }
    const coordinator = await acquireMissionCoordinator(flags, cwd, client, worktree)
    const from = coordinator.handle
    const lifecycle = manageMissionCoordinator(client, coordinator)
    try {
      const planned = await client.call<MissionPlanRpcResult>('mission.plan', {
        text: mission,
        worktree,
        agent: getOptionalStringFlag(flags, 'agent')
      })
      const plan = planned.result.plan
      const objective = plan.mode === 'orchestration' ? plan.objective : mission
      const maxConcurrency = plan.mode === 'orchestration' ? plan.maxConcurrency : 1
      const tasks =
        plan.mode === 'orchestration'
          ? plan.tasks
          : [{ key: 'mission', spec: mission, deps: [] } satisfies MissionTask]

      // Why: a lost Run/worker reply must not destroy its recovery anchor.
      lifecycle.beforeRun()
      const runResponse = await client.call<{ run: { id: string; objective: string } }>(
        'orchestration.runCreate',
        { objective, from }
      )
      const summary = await executeMissionRun({
        client,
        mission,
        runId: runResponse.result.run.id,
        from,
        worktree,
        agent: planned.result.agent,
        agentCandidates: planned.result.agentCandidates,
        tasks,
        maxConcurrency,
        onAttention: (attention) => reportMissionAttention(from, attention)
      })

      lifecycle.markSettled()
      if (summary.state === 'failed') {
        process.exitCode = 1
      }
      printResult(
        { ...runResponse, result: summary },
        json,
        (value) =>
          `Mission run ${value.runId} ${value.state}: ${value.completedTasks} completed, ${value.failedTasks} failed.`
      )
    } catch (error) {
      if (error instanceof MissionWorkerStartFailure && error.settled) {
        lifecycle.markSettled()
      }
      throw error
    } finally {
      try {
        await lifecycle.finish()
      } finally {
        lifecycle.dispose()
      }
    }
  }
}

function reportMissionAttention(from: string, attention: MissionAttention): void {
  console.error(formatMissionAttention(attention, from))
}
