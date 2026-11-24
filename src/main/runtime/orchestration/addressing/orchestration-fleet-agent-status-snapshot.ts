import { orchestrationProjectionFacts } from '../crew/orchestration-projection-facts'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import { conversationRecordReader } from './session-lineage/structured-session-lineage'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { peekOpenedAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-slot'
import {
  RuntimeAgentOrchestrationProjection,
  type RuntimeAgentOrchestrationDependencies
} from '../crew/runtime-agent-orchestration-projection'
import { createOrchestrationProjectionScope } from '../crew/runtime-agent-orchestration-scope'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import {
  mintAgentStatusFleetEvidence,
  type AgentStatusRuntimeEnrichment,
  type ObservedAgentStatusPaneIdentity
} from '../../../ipc/agent-hooks/agent-status-ipc-boundary'

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

export function readCapturedOrchestrationFleetAgentStatusSnapshot(
  source: Omit<FleetAgentStatusSnapshotSource, 'getAgentStatusOrchestrationContextForPaneKey'>,
  dependencies: RuntimeAgentOrchestrationDependencies
): readonly FleetAgentStatusEvidence[] {
  const projection = new RuntimeAgentOrchestrationProjection(dependencies)
  // Captured on the first bound pane so reads with no bound panes stay off the DB.
  let captured:
    | { db: OrchestrationDb | null; scope: ReturnType<typeof createOrchestrationProjectionScope> }
    | null
    | undefined
  const capture = () => {
    const raw = dependencies.getDb()
    const sourceFacts = raw?.db ? orchestrationProjectionFacts(raw) : undefined
    if (raw?.db && !sourceFacts) {
      return null
    }
    const db = sourceFacts?.view ?? raw
    return { db, scope: createOrchestrationProjectionScope(db, dependencies) }
  }
  return readOrchestrationFleetAgentStatusSnapshot({
    ...source,
    getAgentStatusOrchestrationContextForPaneKey: (paneKey) => {
      const handle = source.getAgentStatusTerminalHandleForPaneKey?.(paneKey)
      if (!handle) {
        return undefined
      }
      if (captured === undefined) {
        captured = capture()
      }
      return captured
        ? projection.getForHandle(
            handle,
            captured.db,
            { paneKey, deferAttention: true },
            captured.scope
          )
        : undefined
    }
  })
}

export function readAgentOrchestrationProjectionRecords(context?: TerminalIdentityReadContext) {
  const read = () => {
    const store = getStructuredAgentSessionHost()?.deps.store ?? peekOpenedAgentSessionRecordStore()
    return store ? conversationRecordReader(store) : null
  }
  return context ? context.captureProjectionRecords(read) : read()
}
