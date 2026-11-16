import { paneAgentIdentity } from '../../agent-hooks/server/pane-agent-identity'
import type {
  SleepingAgentSessionRecord,
  AgentProviderSessionMetadata
} from '../../../shared/agent-session/lifecycle/agent-session-resume'

import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'

import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

export abstract class RuntimeAgentStatusSources extends OrcaRuntimeWithTerminalDrivers {
  protected readonly getPaneAgentIdentityFn!: HostBindings['getPaneAgentIdentity'] | null

  readPaneAgentIdentity(
    paneKey: string,
    savedRecord?: SleepingAgentSessionRecord,
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
          savedRecord,
          worktreeId: savedRecord?.worktreeId
        })
  }

  protected paneAgentStatuses(
    rows: readonly AgentStatusIpcPayload[] = this.getAgentProviderSessionSnapshotFn?.() ??
      this.getAgentStatusSnapshotFn?.() ??
      []
  ): AgentStatusIpcPayload[] {
    return rows.flatMap((row) => {
      if (row.structuredHost) {
        return [row]
      }
      const identity = this.readPaneAgentIdentity(row.paneKey, undefined, row)
      return identity && !identity.ended ? [identity.status] : []
    })
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
