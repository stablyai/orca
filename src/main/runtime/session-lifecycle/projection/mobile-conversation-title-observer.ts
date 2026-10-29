import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
export function observeMobileConversationTitles(
  store: RuntimeStore | null,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  refresh: (worktreeId: string, sessionId: string) => void
): void {
  store?.onWorkspaceSessionWritten?.((_hostId, partitions) => {
    if (partitions && partitions.every((changes) => !changes.fullReplacement)) {
      for (const changes of partitions) {
        for (const unit of changes.units) {
          if (unit.field !== 'unifiedTabs' || unit.key === null) {
            continue
          }
          const prior = Array.isArray(unit.prior) ? unit.prior : []
          const next = Array.isArray(unit.next) ? unit.next : []
          const previous = new Map(prior.map((tab) => [tab.id, tab]))
          const affected = new Set<string>()
          for (const tab of next) {
            const before = previous.get(tab.id)
            previous.delete(tab.id)
            if (
              tab.contentType === 'agent-session' &&
              (before?.contentType !== tab.contentType ||
                before.entityId !== tab.entityId ||
                before.label !== tab.label ||
                before.customLabel !== tab.customLabel)
            ) {
              affected.add(tab.entityId)
            }
          }
          for (const tab of previous.values()) {
            if (tab.contentType === 'agent-session') {
              affected.add(tab.entityId)
            }
          }
          if (affected.size === 0) {
            continue
          }
          for (const tab of snapshots.get(unit.key)?.tabs ?? []) {
            if (tab.type === 'agent-session' && affected.has(tab.sessionId)) {
              refresh(unit.key, tab.sessionId)
            }
          }
        }
      }
      return
    }
    for (const [workspaceId, snapshot] of snapshots) {
      for (const tab of snapshot.tabs) {
        if (tab.type === 'agent-session') {
          refresh(workspaceId, tab.sessionId)
        }
      }
    }
  })
}
