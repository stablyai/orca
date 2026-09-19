import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentStatusExecutionBindingResolver } from '../agent-status-execution-binding-resolver'
import type { EnrichedAgentHookEventPayload } from './server-types'

function isEnrichedStatus(
  payload: AgentHookEventPayload | undefined
): payload is EnrichedAgentHookEventPayload {
  return (
    payload !== undefined &&
    'receivedAt' in payload &&
    typeof payload.receivedAt === 'number' &&
    'stateStartedAt' in payload &&
    typeof payload.stateStartedAt === 'number'
  )
}

export type ReportedExecutionBindingResolution = {
  payload: AgentHookEventPayload
  previous?: EnrichedAgentHookEventPayload
  replacement: boolean
}

/** Resolve an emitter claim against the committed owner before status projection. */
export function resolveReportedExecutionBinding(args: {
  payload: AgentHookEventPayload
  previousCandidate: AgentHookEventPayload | undefined
  resolver: AgentStatusExecutionBindingResolver | null
}): ReportedExecutionBindingResolution {
  const previous = isEnrichedStatus(args.previousCandidate) ? args.previousCandidate : undefined
  const reported = args.payload.reportedExecutionBinding
  let payload = args.payload
  let alreadyVerified = Boolean(payload.runId && payload.executionId && !reported)
  const resolved =
    reported && args.resolver
      ? args.resolver({
          paneKey: payload.paneKey,
          worktreeId: payload.worktreeId,
          source: payload.source,
          reported
        })
      : null
  // Why an unresolvable claim only costs the claim: the owner registry is empty for any pane the
  // current process did not launch — after an app restart, once the PTY exits, and for every spooled
  // event replayed from a window when Orca was down. Withholding the state transition there would
  // latch the row on whatever it last said, with nothing re-deriving it. Identity fails closed; the
  // state machine does not.
  if (!reported && !alreadyVerified && previous?.runId && previous.executionId) {
    // Mixed-version emitters may omit the claim; retain the known subject while applying
    // their status transition, but never accept a replacement identity from that event.
    payload = {
      ...payload,
      runId: previous.runId,
      executionId: previous.executionId,
      ...(previous.providerAlias ? { providerAlias: previous.providerAlias } : {}),
      reportedExecutionBinding: undefined
    }
    alreadyVerified = true
  }
  if (resolved) {
    payload = {
      ...payload,
      runId: resolved.runId,
      executionId: resolved.attachment.executionId,
      providerAlias:
        payload.source && payload.providerSession
          ? {
              provider: payload.source,
              sessionKeyKind: payload.providerSession.key,
              providerId: payload.providerSession.id
            }
          : previous?.runId === resolved.runId &&
              previous.executionId === resolved.attachment.executionId
            ? previous.providerAlias
            : undefined,
      reportedExecutionBinding: undefined
    }
  } else if (!alreadyVerified) {
    // Keep legacy rows readable, but never persist or publish an untrusted claim as proof.
    payload = {
      ...payload,
      runId: undefined,
      executionId: undefined,
      providerAlias: undefined,
      reportedExecutionBinding: undefined
    }
  }
  const replacement = Boolean(
    resolved &&
    previous?.runId &&
    previous.executionId &&
    (previous.runId !== resolved.runId || previous.executionId !== resolved.attachment.executionId)
  )
  return { payload, previous, replacement }
}
