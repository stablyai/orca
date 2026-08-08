import type { AgentType } from '../../shared/agent-status-types'

export type CodexSessionOptions = {
  model?: string
  effort?: string
  fastMode?: boolean
  recordedAt: number | null
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function parseAgentSessionOptionsRecord(
  agent: AgentType,
  line: string
): CodexSessionOptions | null {
  if (agent !== 'codex') {
    return null
  }
  let record: Record<string, unknown> | null
  try {
    record = object(JSON.parse(line))
  } catch {
    return null
  }
  const payload = object(record?.payload)
  const settings =
    payload?.type === 'thread_settings_applied' ? object(payload.thread_settings) : null
  // Current rollouts put turn_context at the record level; older ones nested its type.
  const turnContext =
    payload && (record?.type === 'turn_context' || payload.type === 'turn_context') ? payload : null
  const values = settings ?? turnContext
  if (!values) {
    return null
  }
  const model = typeof values.model === 'string' ? values.model.trim() : ''
  const effortValue = values.reasoning_effort ?? values.effort
  const effort = typeof effortValue === 'string' ? effortValue.trim() : ''
  const serviceTier = typeof values.service_tier === 'string' ? values.service_tier : ''
  const fastMode = serviceTier === 'priority' ? true : serviceTier === 'default' ? false : undefined
  if (!model && !effort && fastMode === undefined) {
    return null
  }
  const timestamp =
    typeof record?.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode === undefined ? {} : { fastMode }),
    recordedAt: Number.isFinite(timestamp) ? timestamp : null
  }
}
