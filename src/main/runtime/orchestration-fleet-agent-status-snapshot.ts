import type { TerminalIdentityReadContext } from './terminal/query/terminal-identity-read-context'
import { conversationRecordReader } from './orchestration/structured-session-lineage'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { peekOpenedAgentSessionRecordStore } from './agent-session/records/agent-session-record-store-slot'
import {
  RuntimeAgentOrchestrationProjection,
  type RuntimeAgentOrchestrationDependencies
} from './runtime-agent-orchestration-projection'
import { createOrchestrationProjectionScope } from './runtime-agent-orchestration-scope'
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

export function readCapturedOrchestrationFleetAgentStatusSnapshot(
  source: Omit<FleetAgentStatusSnapshotSource, 'getAgentStatusOrchestrationContextForPaneKey'>,
  dependencies: RuntimeAgentOrchestrationDependencies
): readonly FleetAgentStatusEvidence[] {
  const projection = new RuntimeAgentOrchestrationProjection(dependencies)
  let scope: ReturnType<typeof createOrchestrationProjectionScope> | undefined
  return readOrchestrationFleetAgentStatusSnapshot({
    ...source,
    getAgentStatusOrchestrationContextForPaneKey: (paneKey) => {
      const handle = source.getAgentStatusTerminalHandleForPaneKey?.(paneKey)
      if (!handle) {
        return undefined
      }
      const db = dependencies.getDb()
      scope ??= createOrchestrationProjectionScope(db, dependencies)
      return projection.getForHandle(handle, db, { paneKey }, scope)
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
