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

/** Identity at ingestion, captured by AgentStatusObservedPaneIdentities. */
export type ObservedAgentStatusPaneIdentity =
  | {
      kind: 'observed'
      terminalHandle: string
      processIncarnation: string
      /** The orchestration dispatch that owned the pane then, not whichever owns it now. */
      dispatchId: string | null
    }
  /** Hydrated replay rows stay restoredUnconfirmed and cannot project live. */
  | { kind: 'unobserved' }

/** Resolve terminal identity once for renderer IPC and orchestration fleet evidence. */
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

/** Fence ingestion identity against the current process; replay rows remain unconfirmed without inventing observations. */
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

/** Share identity lookup while preserving optional wire fields understood by older renderers. */
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
