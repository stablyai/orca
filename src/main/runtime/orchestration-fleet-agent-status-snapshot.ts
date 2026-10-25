import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import {
  mintAgentStatusFleetEvidence,
  type AgentStatusRuntimeEnrichment,
  type ObservedAgentStatusPaneIdentity
} from '../ipc/agent-status-ipc-boundary'

/** Hook rows plus registry identity lookups and the identity observed when each row arrived. */
export type FleetAgentStatusSnapshotSource = AgentStatusRuntimeEnrichment & {
  getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  readObservedAgentStatusPaneIdentityFn: (paneKey: string) => ObservedAgentStatusPaneIdentity
}

/** Convert pane-keyed hooks to terminal evidence; callers must redact payload text. */
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
