import { z } from 'zod'
import { lazyZodSchema } from '../../../../../../../shared/schema/lazy-zod-schema'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { DispatchContextRow } from '../../../../../orchestration/db/orchestration-records'
import { parseRecordedWorkerLaunchOptions } from '../start/launch/worker-launch-preferences'

const EARLIER_WORK_CLIP = 2_000

const WorkerReport = lazyZodSchema(() =>
  z.looseObject({
    outcome: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional()
  })
)

function parseJson(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** The agent and launch choices the worker first started with, for a fresh start of the same kind. */
export function parseStartOptions(raw: string): {
  agent?: string
  model?: string
  effort?: string
} {
  const parsed = parseRecordedWorkerLaunchOptions(raw)
  return {
    agent: isTuiAgent(parsed.agent) ? parsed.agent : undefined,
    model: parsed.model,
    effort: parsed.effort
  }
}

/** The earlier task and report, for a fresh agent that cannot reopen the conversation. */
export function earlierWork(db: OrchestrationDb, latest: DispatchContextRow): string {
  const task = db.getTask(latest.task_id)
  const clip = (text: string) =>
    text.length > EARLIER_WORK_CLIP ? `${text.slice(0, EARLIER_WORK_CLIP)}…` : text
  const lines = ['Earlier work on this worker (its conversation could not be reopened):']
  if (task) {
    lines.push(`Earlier task: ${clip(task.spec)}`)
  }
  const report = WorkerReport.safeParse(parseJson(task?.result ?? null))
  if (report.success) {
    const text = [report.data.subject, report.data.body].filter(Boolean).join(' — ')
    lines.push(`Its report (${report.data.outcome ?? 'unknown'}): ${clip(text)}`)
  }
  return lines.join('\n')
}
