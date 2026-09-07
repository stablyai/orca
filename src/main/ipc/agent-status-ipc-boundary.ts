import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  mintFleetAgentStatusEvidence,
  type FleetAgentStatusEvidence,
  type FleetEvidenceBinding
} from '../../shared/orchestration-fleet-agent-status-evidence'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  | 'getAgentStatusTerminalHandleForPaneKey'
  | 'getAgentStatusOrchestrationContextForPaneKey'
  | 'getTerminalProcessIncarnation'
>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

/** What the runtime resolved for a pane at the moment a status row was ingested. Captured by
 *  `AgentStatusObservedPaneIdentities`, which is where the arms are documented. */
export type ObservedAgentStatusPaneIdentity =
  | {
      kind: 'observed'
      terminalHandle: string
      processIncarnation: string
      /** The orchestration dispatch that owned the pane then, not whichever owns it now. */
      dispatchId: string | null
    }
  /** No status arrival was seen for this pane in this runtime: a hydrated replay row, or one
   *  reconciled from it. Those carry `restoredUnconfirmed` and never project `live`. */
  | { kind: 'unobserved' }

/** The one place a pane key becomes terminal identity. Both the IPC payload the renderer
 *  decodes and the fleet evidence the orchestration path reads are derived from this. */
export function resolveAgentStatusBinding(
  paneKey: string,
  runtime: AgentStatusRuntimeEnrichment | undefined
): FleetEvidenceBinding {
  const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
  if (!terminalHandle) {
    return { kind: 'unresolved', reason: 'pane_not_bound' }
  }
  const processIncarnation = runtime?.getTerminalProcessIncarnation(terminalHandle)
  if (!processIncarnation) {
    return { kind: 'unresolved', reason: 'incarnation_unbound' }
  }
  const dispatchId = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)?.dispatchId
  return dispatchId
    ? { kind: 'worker', dispatchId, terminalHandle, paneKey, processIncarnation }
    : { kind: 'pane', terminalHandle, paneKey, processIncarnation }
}

/**
 * The identity the row was observed under, fenced against the pane's identity now.
 *
 * The fleet path reads cached rows, so resolving identity here would describe whatever process
 * and dispatch the pane owns at read time rather than the one the agent reported from. A row
 * this runtime never observed keeps the current resolution: it is a hydrated replay, already
 * held off `live` by `restoredUnconfirmed`, and inventing an observation for it would be worse.
 */
export function resolveObservedAgentStatusBinding(
  paneKey: string,
  runtime: AgentStatusRuntimeEnrichment | undefined,
  observed: ObservedAgentStatusPaneIdentity
): FleetEvidenceBinding {
  const current = resolveAgentStatusBinding(paneKey, runtime)
  if (observed.kind === 'unobserved' || current.kind === 'unresolved') {
    return current
  }
  if (
    current.terminalHandle !== observed.terminalHandle ||
    current.processIncarnation !== observed.processIncarnation
  ) {
    return { kind: 'unresolved', reason: 'stale_incarnation' }
  }
  const terminal = {
    terminalHandle: observed.terminalHandle,
    paneKey,
    processIncarnation: observed.processIncarnation
  }
  return observed.dispatchId
    ? { kind: 'worker', dispatchId: observed.dispatchId, ...terminal }
    : { kind: 'pane', ...terminal }
}

export function mintAgentStatusFleetEvidence(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined,
  observed: ObservedAgentStatusPaneIdentity
): FleetAgentStatusEvidence {
  return mintFleetAgentStatusEvidence(
    data,
    resolveObservedAgentStatusBinding(data.paneKey, runtime, observed)
  )
}

/** Unchanged wire shape: `agentStatus:set` and `agentStatus:getSnapshot` still publish the
 *  same optional fields an older renderer decodes. Only the identity lookup is shared. */
export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

export function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}
