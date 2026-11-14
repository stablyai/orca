import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'

export function providerSessionIndexKey(
  agent: string | undefined,
  session: AgentProviderSessionMetadata
): string {
  return JSON.stringify([
    agent,
    session.key,
    session.id,
    agent === 'pi' || agent === 'prime-agent' ? session.transcriptPath : null
  ])
}

/** Key-only query dependencies; accepted records stay in their existing owner. */
export class AgentStatusQueryIndex {
  private readonly associations = new Map<
    string,
    { tabs: Set<string>; sessions: Set<string>; sessionIds: Set<string> }
  >()
  readonly byTab = new Map<string, Set<string>>()
  readonly bySessionId = new Map<string, Set<string>>()
  readonly bySession = new Map<string, Set<string>>()

  update(paneKey: string, rows: readonly AgentStatusIpcPayload[]): void {
    const previous = this.associations.get(paneKey)
    const tabs = new Set<string>(),
      sessions = new Set<string>(),
      sessionIds = new Set<string>()
    for (const row of rows) {
      const tabId = row.tabId ?? parsePaneKey(row.paneKey)?.tabId
      if (tabId) {
        tabs.add(tabId)
      }
      if (row.providerSession) {
        sessions.add(providerSessionIndexKey(row.agentType, row.providerSession))
        sessionIds.add(row.providerSession.id)
      }
    }
    const replace = (
      index: Map<string, Set<string>>,
      before: Set<string> | undefined,
      after: Set<string>
    ): void => {
      for (const key of before ?? []) {
        if (after.has(key)) {
          continue
        }
        const panes = index.get(key)
        panes?.delete(paneKey)
        if (!panes?.size) {
          index.delete(key)
        }
      }
      for (const key of after) {
        const panes = index.get(key) ?? new Set<string>()
        panes.add(paneKey)
        index.set(key, panes)
      }
    }
    replace(this.byTab, previous?.tabs, tabs)
    replace(this.bySessionId, previous?.sessionIds, sessionIds)
    replace(this.bySession, previous?.sessions, sessions)
    if (tabs.size || sessions.size) {
      this.associations.set(paneKey, { tabs, sessions, sessionIds })
    } else {
      this.associations.delete(paneKey)
    }
  }
}
