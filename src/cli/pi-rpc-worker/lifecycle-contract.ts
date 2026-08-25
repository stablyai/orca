import type {
  LifecycleToolInput,
  LifecycleToolName,
  WorkerAskInput,
  WorkerDoneInput,
  WorkerEscalationInput,
  WorkerProgressInput
} from './types'
import { LIFECYCLE_TOOL_NAMES } from './types'

const PROGRESS_PHASES: ReadonlySet<WorkerProgressInput['phase']> = new Set([
  'investigating',
  'implementing',
  'reviewing',
  'waiting'
])

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('Invalid lifecycle tool fields')
  }
}

export function boundedLifecycleText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid lifecycle ${label}`)
  }
  return value
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedLifecycleText(value, label, max)
}

function textArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxChars: number
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid lifecycle ${label}`)
  }
  return value.map((entry) => boundedLifecycleText(entry, label, maxChars))
}

export function parseLifecycleToolInput(name: LifecycleToolName, raw: unknown): LifecycleToolInput {
  const input = record(raw, `${name} input`)
  if (name === 'orca_worker_done') {
    keys(input, ['outcome', 'subject', 'body'], ['filesModified', 'reportPath'])
    if (input.outcome !== 'succeeded' && input.outcome !== 'failed') {
      throw new Error('Invalid lifecycle outcome')
    }
    return {
      name,
      input: {
        outcome: input.outcome,
        subject: boundedLifecycleText(input.subject, 'subject', 160),
        body: boundedLifecycleText(input.body, 'body', 4_096),
        ...(input.filesModified === undefined
          ? {}
          : { filesModified: textArray(input.filesModified, 'filesModified', 128, 1_024) }),
        ...(input.reportPath === undefined
          ? {}
          : { reportPath: optionalText(input.reportPath, 'reportPath', 2_048) })
      }
    }
  }
  if (name === 'orca_ask_coordinator') {
    keys(input, ['question'], ['options'])
    const options = textArray(input.options, 'options', 20, 256)
    if (options?.some((option) => option.includes(','))) {
      throw new Error('Coordinator question options cannot contain commas')
    }
    return {
      name,
      input: {
        question: boundedLifecycleText(input.question, 'question', 4_096),
        ...(options ? { options } : {})
      }
    }
  }
  if (name === 'orca_escalate') {
    keys(input, ['subject', 'body'])
    return {
      name,
      input: {
        subject: boundedLifecycleText(input.subject, 'subject', 160),
        body: boundedLifecycleText(input.body, 'body', 4_096)
      }
    }
  }
  keys(input, ['phase', 'message'])
  const phase = boundedLifecycleText(input.phase, 'phase', 64)
  if (!PROGRESS_PHASES.has(phase as WorkerProgressInput['phase'])) {
    throw new Error('Invalid lifecycle progress phase')
  }
  return {
    name,
    input: {
      phase: phase as WorkerProgressInput['phase'],
      message: boundedLifecycleText(input.message, 'message', 2_048)
    }
  }
}

export function isLifecycleTool(name: string): name is LifecycleToolName {
  return LIFECYCLE_TOOL_NAMES.includes(name as LifecycleToolName)
}

export function assertLifecycleResult(resultValue: unknown, lifecycle: LifecycleToolInput): void {
  const result = record(resultValue, 'lifecycle tool result')
  const details = record(result.details, 'lifecycle tool details')
  keys(details, ['protocol', 'version', 'kind', 'payload'])
  const expectedKind = lifecycleResultKind(lifecycle)
  if (
    details.protocol !== 'orca.pi.lifecycle' ||
    details.version !== 1 ||
    details.kind !== expectedKind ||
    JSON.stringify(canonicalize(details.payload)) !== JSON.stringify(canonicalize(lifecycle.input))
  ) {
    throw new Error('Pi lifecycle result did not match the selected tool call')
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

function lifecycleResultKind(
  lifecycle: LifecycleToolInput
): 'worker_done' | 'ask' | 'escalation' | 'progress' {
  if (lifecycle.name === 'orca_worker_done') {
    return 'worker_done'
  }
  if (lifecycle.name === 'orca_ask_coordinator') {
    return 'ask'
  }
  if (lifecycle.name === 'orca_escalate') {
    return 'escalation'
  }
  return 'progress'
}

export type { WorkerAskInput, WorkerDoneInput, WorkerEscalationInput, WorkerProgressInput }
