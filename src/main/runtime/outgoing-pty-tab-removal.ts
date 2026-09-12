import type { RuntimeSyncedTab } from '../../shared/runtime-types'

export function prepareOutgoingPtyTabRemoval(
  ptyIds: readonly string[],
  read: () => {
    tabs: Map<string, RuntimeSyncedTab>
    leaves: ReadonlyMap<string, { tabId: string; ptyId: string | null }>
  }
) {
  const ids = new Set(ptyIds)
  const initial = read()
  const tabIds = new Set(
    [...initial.leaves.values()]
      .filter((leaf) => leaf.ptyId && ids.has(leaf.ptyId))
      .map((leaf) => leaf.tabId)
  )
  const signature = (tab: RuntimeSyncedTab | undefined) =>
    JSON.stringify(tab && { tabId: tab.tabId, worktreeId: tab.worktreeId, layout: tab.layout })
  const entries = [...tabIds].map((id) => {
    const tab = initial.tabs.get(id)
    return { id, tab, signature: signature(tab), removed: false }
  })
  const assertCurrent = () => {
    const current = read()
    for (const entry of entries) {
      const tab = current.tabs.get(entry.id)
      if (
        tab !== (entry.removed ? undefined : entry.tab) ||
        (!entry.removed && signature(tab) !== entry.signature)
      ) {
        throw new Error('orcad_outgoing_source_tab_changed')
      }
    }
  }
  return {
    assertCurrent,
    removeEmpty() {
      assertCurrent()
      const current = read()
      const occupied = new Set([...current.leaves.values()].map((leaf) => leaf.tabId))
      for (const entry of entries) {
        if (!entry.removed && !occupied.has(entry.id)) {
          current.tabs.delete(entry.id)
          entry.removed = true
        }
      }
      assertCurrent()
    }
  }
}
