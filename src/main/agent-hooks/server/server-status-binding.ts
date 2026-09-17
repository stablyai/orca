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

export type AgentStatusBindingResolution = {
  payload: AgentHookEventPayload
  previous?: EnrichedAgentHookEventPayload
  suppress: boolean
  replacement: boolean
}

/** Resolve an emitter claim against the committed owner before status projection. */
export function resolveAgentStatusBinding(args: {
  payload: AgentHookEventPayload
  previousCandidate: AgentHookEventPayload | undefined
  resolver: AgentStatusExecutionBindingResolver | null
}): AgentStatusBindingResolution {
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
          emitterRole: payload.emitterRole,
          reported
        })
      : null
  if (reported && args.payload.emitterRole === 'child' && !resolved) {
    // An inherited root claim is not child identity. Without a verified child-work
    // admission, suppress even a first child event so it cannot create a pane fallback.
    return { payload, previous, suppress: true, replacement: false }
  }
  if (reported && !resolved && previous?.runId && previous.executionId) {
    // A delayed prior owner or inherited claim cannot rewrite the confirmed subject.
    return { payload, previous, suppress: true, replacement: false }
  }
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
  return { payload, previous, suppress: false, replacement }
}
