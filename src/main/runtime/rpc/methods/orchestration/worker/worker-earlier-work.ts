import { z } from 'zod'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { DispatchContextRow } from '../../../../orchestration/types'

const EARLIER_WORK_CLIP = 2_000

const StartOptions = z.looseObject({
  agent: z.string().nullish(),
  launch: z
    .looseObject({
      requested: z
        .looseObject({ model: z.string().nullish(), effort: z.string().nullish() })
        .nullish()
    })
    .nullish()
})

const WorkerReport = z.looseObject({
  outcome: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional()
})

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
  const parsed = StartOptions.safeParse(parseJson(raw))
  if (!parsed.success) {
    return {}
  }
  const requested = parsed.data.launch?.requested
  return {
    agent: isTuiAgent(parsed.data.agent) ? parsed.data.agent : undefined,
    model: requested?.model ?? undefined,
    effort: requested?.effort ?? undefined
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
