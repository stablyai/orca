import { AgentStatusQueryIndex, providerSessionIndexKey } from './agent-status-query-index'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

import { AgentHookServerState } from './server-state'

export abstract class AgentHookServerStatusQueries extends AgentHookServerState {
  abstract getStatusSnapshot(): AgentStatusIpcPayload[]
  abstract getStatusSnapshotForPane(paneKey: string): AgentStatusIpcPayload[]

  protected statusQueryIndex: AgentStatusQueryIndex | null = null

  protected clearRuntimeStatusQueries(): void {
    this.runtimeObservedStatusPaneKeys.clear()
    this.paneKeyByTerminalHandle.clear()
    this.statusQueryIndex = null
  }

  private queryIndex(): AgentStatusQueryIndex {
    if (!this.statusQueryIndex) {
      this.statusQueryIndex = new AgentStatusQueryIndex()
      const byPane = new Map<string, AgentStatusIpcPayload[]>()
      for (const row of this.getStatusSnapshot()) {
        const rows = byPane.get(row.paneKey) ?? []
        rows.push(row)
        byPane.set(row.paneKey, rows)
      }
      for (const [paneKey, rows] of byPane) {
        this.statusQueryIndex.update(paneKey, rows)
      }
    }
    return this.statusQueryIndex
  }

  protected updateStatusQueryIndex(paneKey: string): void {
    this.statusQueryIndex?.update(paneKey, this.getStatusSnapshotForPane(paneKey))
  }

  getProviderSessionSourceRowsForTab(tabId: string): AgentStatusIpcPayload[] {
    return Array.from(this.queryIndex().byTab.get(tabId) ?? []).flatMap((key) =>
      this.getStatusSnapshotForPane(key)
    )
  }

  getProviderSessionSourceRowsForSessionId(sessionId: string): AgentStatusIpcPayload[] {
    return Array.from(this.queryIndex().bySessionId.get(sessionId) ?? []).flatMap((key) =>
      this.getStatusSnapshotForPane(key)
    )
  }

  getProviderSessionSourceRowsForSession(
    agent: string,
    session: AgentProviderSessionMetadata
  ): AgentStatusIpcPayload[] {
    return Array.from(
      this.queryIndex().bySession.get(providerSessionIndexKey(agent, session)) ?? []
    ).flatMap((key) => this.getStatusSnapshotForPane(key))
  }
}
