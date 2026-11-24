import { abbreviateOrchestrationText } from '../../../shared/orchestration/orchestration-task-summary'
import { getOptionalStringFlag } from '../../arguments/flags'
import type { CommandHandler, HandlerContext } from '../../dispatch/dispatch'
import { printOrchestrationResult } from '../agent-view'
import { runScopedSessionCaller } from '../identity/terminal-identity'

type Run = { id: string; objective: string; legacy?: number }
type Gate = { id: string; task_id: string; question: string }

async function summarizeRun(client: HandlerContext['client'], run: Run, from: string | undefined) {
  const [tasks, gates] = await Promise.allSettled([
    client.call<{ tasks: { status: string }[] }>('orchestration.taskList', {
      run: run.id,
      callerTerminalHandle: from,
      brief: true
    }),
    client.call<{ gates: Gate[] }>('orchestration.gateList', {
      run: run.id,
      from,
      status: 'pending'
    })
  ])
  const counts = new Map<string, number>()
  if (tasks.status === 'fulfilled') {
    for (const task of tasks.value.result.tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
    }
  }
  const pending = gates.status === 'fulfilled' ? gates.value.result.gates : null
  return {
    runId: run.id,
    objective: abbreviateOrchestrationText(run.objective),
    taskCounts: tasks.status === 'fulfilled' ? Object.fromEntries(counts) : null,
    pendingDecisions: pending?.length ?? null,
    decisions:
      pending?.slice(0, 3).map((gate) => ({
        id: gate.id,
        taskId: gate.task_id,
        question: abbreviateOrchestrationText(gate.question)
      })) ?? null,
    ...(tasks.status === 'rejected' && { taskReadError: briefError(tasks.reason) }),
    ...(gates.status === 'rejected' && { gateReadError: briefError(gates.reason) })
  }
}

function briefError(error: unknown): string {
  return abbreviateOrchestrationText(error instanceof Error ? error.message : String(error))
}

export const commanderBriefing: CommandHandler = async ({ flags, client, json }) => {
  const result = await client.call<{ runs: Run[]; nextCursor?: string | null }>(
    'orchestration.runList',
    {
      limit: 8,
      cursor: getOptionalStringFlag(flags, 'cursor')
    }
  )
  const from = runScopedSessionCaller(flags)
  const goals: Awaited<ReturnType<typeof summarizeRun>>[] = []
  for (const run of result.result.runs) {
    if (!run.legacy) {
      goals.push(await summarizeRun(client, run, from))
    }
  }
  printOrchestrationResult(result, json, {
    fields: () => ({ goals, nextCursor: result.result.nextCursor ?? undefined })
  })
}
