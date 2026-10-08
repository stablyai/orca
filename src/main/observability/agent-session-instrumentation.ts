import { withSpan, type ActiveSpan } from './tracer'

export type AgentSessionCreatePhase =
  | 'reconcile_leases'
  | 'resolve_recovery'
  | 'probe_owner'
  | 'reserve_owner'
  | 'acquire_owner'
  | 'auth_settle'
  | 'spawn'
  | 'restore_options'
  | 'publish'

export type AgentSessionCreatePhaseTiming = {
  readonly phase: AgentSessionCreatePhase
  readonly startedAtMs: number
  readonly durationMs: number
}

export type AgentSessionCreatePhaseRecorder = (timing: AgentSessionCreatePhaseTiming) => void

/** Wrap the rare user-created structured session; no sampling is needed for this event. */
export async function withAgentSessionSpan<T>(fn: (span: ActiveSpan) => Promise<T>): Promise<T> {
  return withSpan('agentSession.create', fn, { attributes: { kind: 'agent-session' } })
}

export async function withAgentSessionCreatePhase<T>(
  phase: AgentSessionCreatePhase,
  record: AgentSessionCreatePhaseRecorder | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const startedAtMs = Date.now()
  try {
    return await fn()
  } finally {
    record?.({ phase, startedAtMs, durationMs: Math.max(0, Date.now() - startedAtMs) })
  }
}

/** Records the closed create vocabulary without copying branch, path, prompt, or session content. */
export function addAgentSessionCreatePhaseAttributes(
  span: ActiveSpan,
  timing: {
    totalDurationMs: number
    phases: readonly AgentSessionCreatePhaseTiming[]
  }
): void {
  span.setAttribute('agent_session.create.total_ms', Math.round(timing.totalDurationMs))
  const phaseDurations = new Map<AgentSessionCreatePhase, number>()
  for (const phase of timing.phases) {
    phaseDurations.set(phase.phase, (phaseDurations.get(phase.phase) ?? 0) + phase.durationMs)
  }
  for (const [phase, durationMs] of phaseDurations) {
    span.setAttribute(`agent_session.create.phase.${phase}_ms`, Math.round(durationMs))
  }
  const intervals = [...timing.phases]
    .map(({ startedAtMs, durationMs }) => [startedAtMs, startedAtMs + durationMs] as const)
    .sort((left, right) => left[0] - right[0])
  let coveredMs = 0
  let openedAt: number | null = null
  let closesAt = 0
  for (const [start, end] of intervals) {
    if (openedAt === null) {
      openedAt = start
      closesAt = end
    } else if (start <= closesAt) {
      closesAt = Math.max(closesAt, end)
    } else {
      coveredMs += closesAt - openedAt
      openedAt = start
      closesAt = end
    }
  }
  if (openedAt !== null) {
    coveredMs += closesAt - openedAt
  }
  span.setAttribute(
    'agent_session.create.unattributed_ms',
    Math.max(0, Math.round(timing.totalDurationMs - coveredMs))
  )
}
