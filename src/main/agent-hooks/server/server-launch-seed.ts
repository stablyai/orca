import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session/lifecycle/agent-session-resume'

/** The pane's row is still the seed its latest resumed launch wrote: no hook has reported since. */
export function isLaunchSeedRow(
  row: AgentHookEventPayload,
  agent: string,
  providerSession: AgentProviderSessionMetadata
): boolean {
  return (
    row.providerSessionOnly === true &&
    !row.connectionId &&
    !row.structuredHost &&
    row.source === undefined &&
    row.hookEventName === undefined &&
    row.payload.agentType === agent &&
    agentProviderSessionsEqual(agent, row.providerSession, providerSession)
  )
}

/** A terminal observation continuing the same conversation keeps the hook provenance it replaced,
 *  as an identical refresh already does, so it never reads as a launch seed. */
export function withHookProvenance<Row extends AgentHookEventPayload>(
  previous: AgentHookEventPayload | undefined,
  applied: Row | undefined
): Row | null {
  if (
    !previous ||
    !applied ||
    (previous.source === undefined && previous.hookEventName === undefined) ||
    applied.source !== undefined ||
    applied.hookEventName !== undefined ||
    applied.connectionId !== previous.connectionId ||
    applied.payload.agentType !== previous.payload.agentType ||
    !agentProviderSessionsEqual(
      applied.payload.agentType,
      applied.providerSession,
      previous.providerSession
    )
  ) {
    return null
  }
  return { ...applied, source: previous.source, hookEventName: previous.hookEventName }
}
