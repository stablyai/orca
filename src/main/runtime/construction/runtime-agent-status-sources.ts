import { paneAgentIdentity } from '../../agent-hooks/server/pane-agent-identity'
import {
  isPaneSleepRecord,
  type SleepingAgentSessionRecord,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session/lifecycle/agent-session-resume'

import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'

import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

export abstract class RuntimeAgentStatusSources extends OrcaRuntimeWithTerminalDrivers {
  protected getPaneAgentIdentityFn: HostBindings['getPaneAgentIdentity'] | null = null

  readPaneAgentIdentity(
    paneKey: string,
    savedRecord?: SleepingAgentSessionRecord | null,
    row?: AgentStatusIpcPayload
  ) {
    return this.getPaneAgentIdentityFn
      ? this.getPaneAgentIdentityFn(paneKey, savedRecord)
      : paneAgentIdentity({
          paneKey,
          row:
            row ??
            this.getAgentProviderSessionRowsForPaneFn?.(paneKey).find(
              (row) => row.paneKey === paneKey
            ),
          savedRecord: savedRecord ?? undefined,
          worktreeId: savedRecord?.worktreeId
        })
  }

  protected paneAgentStatuses(
    rows: readonly AgentStatusIpcPayload[] = this.getAgentProviderSessionSnapshotFn?.() ??
      this.getAgentStatusSnapshotFn?.() ??
      [],
    savedRecords: Iterable<SleepingAgentSessionRecord> = []
  ): AgentStatusIpcPayload[] {
    const paneKeys = new Set(rows.map((row) => row.paneKey))
    const statuses = rows.flatMap((row) => {
      if (row.structuredHost) {
        return [row]
      }
      // A live pane's resume-only row (a dismissed agent) carries identity, never status.
      if (row.providerSessionOnly) {
        return []
      }
      const identity = this.readPaneAgentIdentity(row.paneKey, undefined, row)
      return identity && !identity.ended ? [identity.status] : []
    })
    for (const record of savedRecords) {
      // Only a slept pane's record stands for its agent; a live or quit checkpoint is recovery,
      // never proof that an agent runs there now.
      if (paneKeys.has(record.paneKey) || !isPaneSleepRecord(record)) {
        continue
      }
      const identity = this.readPaneAgentIdentity(record.paneKey, record)
      if (identity && !identity.ended) {
        paneKeys.add(record.paneKey)
        statuses.push(identity.status)
      }
    }
    return statuses
  }

  readonly getAgentStatusSnapshotFn!: HostBindings['getAgentStatusSnapshot'] | null

  protected readonly structuredAgentStatusSinkFn!: HostBindings['structuredAgentStatusSink'] | null

  readonly readObservedAgentStatusPaneIdentityFn!: HostBindings['readObservedAgentStatusPaneIdentity']

  protected readonly getAgentProviderSessionSnapshotFn!:
    | HostBindings['getAgentProviderSessionSnapshot']
    | null

  protected readonly getAgentProviderSessionRowsForSessionFn!:
    | HostBindings['getAgentProviderSessionRowsForSession']
    | null

  getAgentRowsForProviderSession(
    agent: string,
    session: AgentProviderSessionMetadata
  ): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionRowsForSessionFn?.(agent, session) ?? []
  }

  protected readonly getAgentProviderSessionRowsForPaneFn!:
    | HostBindings['getAgentProviderSessionRowsForPane']
    | null

  /** Includes resume-identity-only provider rows. */
  getAgentProviderSessionRows(tabId?: string): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionSnapshotFn?.(tabId) ?? []
  }

  getAgentStatusRowsForPane(paneKey: string): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
  }
}
