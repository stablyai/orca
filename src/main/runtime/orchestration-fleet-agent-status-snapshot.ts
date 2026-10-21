import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import {
  mintAgentStatusFleetEvidence,
  type AgentStatusRuntimeEnrichment,
  type ObservedAgentStatusPaneIdentity
} from '../ipc/agent-status-ipc-boundary'

/** The runtime facts the fleet snapshot needs: the hook rows, the pane identity lookups the
 *  terminal registry owns, and the identity each pane was observed under when its row arrived. */
export type FleetAgentStatusSnapshotSource = AgentStatusRuntimeEnrichment & {
  getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  readObservedAgentStatusPaneIdentityFn: (paneKey: string) => ObservedAgentStatusPaneIdentity
}

/**
 * Push-fed hook rows minted into fleet evidence. Callers must redact payload text.
 *
 * Hook rows use pane keys, while fleet evidence matches terminal identities.
 */
export function readOrchestrationFleetAgentStatusSnapshot(
  runtime: FleetAgentStatusSnapshotSource
): readonly FleetAgentStatusEvidence[] {
  return (runtime.getAgentStatusSnapshotFn?.() ?? []).map((entry) =>
    mintAgentStatusFleetEvidence(
      entry,
      runtime,
      runtime.readObservedAgentStatusPaneIdentityFn(entry.paneKey)
    )
  )
}
