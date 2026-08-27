import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector } from '../selectors'
import {
  executeMissionRun,
  type MissionPlanRpcResult,
  type MissionTask
} from './mission/mission-supervisor'
import { resolveCoordinatorTerminalHandle } from './orchestration/terminal-identity'

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
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
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
      tasks,
      maxConcurrency
    })

    if (summary.state === 'failed') {
      process.exitCode = 1
    }
    printResult(
      { ...runResponse, result: summary },
      json,
      (value) =>
        `Mission run ${value.runId} ${value.state}: ${value.completedTasks} completed, ${value.failedTasks} failed.`
    )
  }
}
