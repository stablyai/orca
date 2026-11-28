import {
  isAgentSessionId,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isAgentSessionSurfaceTabId } from '../../../../shared/agent-session/view/agent-session-surface-tab-id'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { AgentSessionTabTable } from '../../../runtime/agent-session/records/agent-session-tab-table'
import { isReadableAgentSessionStoreTab } from '../../../runtime/agent-session/records/agent-session-store-row-rules'
import { clearSuccessor } from '../../../runtime/agent-session/records/agent-session-sender-identity-revision'

/** The pre-index format keeps the original tab id through a chain of /clear commands. */
export function parseLegacyAgentSessionTabTable(
  file: Record<string, unknown>,
  records: ReadonlyMap<string, AgentSessionRecord>
): AgentSessionTabTable | null | undefined {
  if (file.sessionTabs !== undefined) {
    if (!Array.isArray(file.sessionTabs)) {
      return undefined
    }
    const tabs = new AgentSessionTabTable()
    for (const entry of file.sessionTabs) {
      if (
        !isReadableAgentSessionStoreTab(entry) ||
        tabs.sessionIdFor(entry.tabId) !== undefined ||
        tabs.tabIdFor(entry.sessionId) !== undefined
      ) {
        return undefined
      }
      tabs.show(entry.sessionId, entry.tabId)
    }
    return tabs
  }
  if (file.visibleSessionIds === undefined) {
    return null
  }
  if (!Array.isArray(file.visibleSessionIds)) {
    return undefined
  }
  const ids = [...new Set(file.visibleSessionIds.filter(isAgentSessionId))]
  const predecessors = new Map<string, string>()
  for (const record of records.values()) {
    const successor = clearSuccessor(record)
    if (successor !== null && !predecessors.has(successor)) {
      predecessors.set(successor, record.sessionId)
    }
  }
  const cleared = new Set(predecessors.values())
  const assigned = new Map<string, string>()
  const taken = new Set<string>()
  const candidates = (id: string): string[] => {
    const record = records.get(id)
    return [
      record && 'surfaceTabId' in record ? record.surfaceTabId : undefined,
      structuredAgentSessionTabId(id)
    ].filter(isAgentSessionSurfaceTabId)
  }
  const assign = (id: string, choices: string[]): void => {
    let tabId = choices.find((choice) => !taken.has(choice))
    if (tabId === undefined) {
      const base = `${structuredAgentSessionTabId(id)}-reopened`
      tabId = base
      for (let suffix = 2; taken.has(tabId); suffix += 1) {
        tabId = `${base}-${suffix}`
      }
    }
    taken.add(tabId)
    assigned.set(id, tabId)
  }
  for (const id of ids) {
    if (cleared.has(id)) {
      continue
    }
    let root = id
    let prior = predecessors.get(root)
    const seen = new Set([id])
    while (prior !== undefined && !seen.has(prior)) {
      seen.add(prior)
      root = prior
      prior = predecessors.get(root)
    }
    if (root !== id) {
      assign(id, [...candidates(root), ...candidates(id)])
    }
  }
  for (const id of ids) {
    if (!assigned.has(id)) {
      assign(id, candidates(id))
    }
  }
  return new AgentSessionTabTable(ids.map((id) => [assigned.get(id)!, id]))
}
