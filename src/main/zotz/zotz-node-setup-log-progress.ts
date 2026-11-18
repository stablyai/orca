import type {
  ZotzNodeSetupStep,
  ZotzNodeSetupStepId
} from '../../shared/zotz/zotz-node-setup-contract'

const LINE_PREFIX = '[zotz] '
const STEP_START = /^== (\w+) ==$/
const STEP_RESULT = /^(\w+) -> (done|skipped|failed)(?:: (.*))?$/
const SETTLED_STATUSES = ['done', 'skipped', 'failed'] as const

/** Live per-step state read from the transcript zotz-node-setup.ps1 writes while it runs. */
export function parseNodeSetupLogProgress(
  log: string,
  stepIds: readonly ZotzNodeSetupStepId[]
): ZotzNodeSetupStep[] {
  const byId = new Map<ZotzNodeSetupStepId, ZotzNodeSetupStep>(
    stepIds.map((id) => [id, { id, status: 'pending' }])
  )
  let current: ZotzNodeSetupStepId | null = null
  for (const rawLine of log.split(/\r?\n/)) {
    if (!rawLine.startsWith(LINE_PREFIX)) {
      continue
    }
    const line = rawLine.slice(LINE_PREFIX.length).trim()
    const started = STEP_START.exec(line)
    const startedId = started ? stepIds.find((id) => id === started[1]) : undefined
    if (startedId) {
      current = startedId
      byId.set(startedId, { id: startedId, status: 'running' })
      continue
    }
    const settled = STEP_RESULT.exec(line)
    const settledId = settled ? stepIds.find((id) => id === settled[1]) : undefined
    const status = settled ? SETTLED_STATUSES.find((value) => value === settled[2]) : undefined
    if (settled && settledId && status) {
      byId.set(settledId, { id: settledId, status, ...(settled[3] ? { detail: settled[3] } : {}) })
      current = current === settledId ? null : current
      continue
    }
    if (current) {
      byId.set(current, { id: current, status: 'running', detail: line })
    }
  }
  return stepIds.map((id) => byId.get(id)!)
}

const TRANSCRIPT_RULE = /^\*{10,}$/

/** Script output between the transcript's header and footer banners, without the `[zotz]` tag. */
export function nodeSetupTranscriptLines(log: string): string[] {
  const lines = log.replace(/^\uFEFF/, '').split(/\r?\n/)
  const rules = lines.flatMap((line, index) => (TRANSCRIPT_RULE.test(line.trim()) ? [index] : []))
  // The header is the first two rules; the footer opens with a third one.
  if (rules.length < 2) {
    return []
  }
  const start = rules[1]! + 1
  const end = rules.length >= 3 ? rules[2]! : lines.length
  return lines
    .slice(start, end)
    .map((line) => (line.startsWith(LINE_PREFIX) ? line.slice(LINE_PREFIX.length) : line).trimEnd())
    .filter((line) => line.length > 0)
}
