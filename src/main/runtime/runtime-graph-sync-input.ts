import type { RuntimeSyncedLeaf, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

/** The runtime indexes graph tabs by bare id, so duplicate ids cannot be routed safely. */
export function assertUniqueRuntimeGraphTabIds(tabs: readonly RuntimeSyncedTab[]): void {
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (seen.has(tab.tabId)) {
      throw new Error('duplicate_runtime_tab_id')
    }
    seen.add(tab.tabId)
  }
}

export function indexIncomingRuntimePtyOwners(input: {
  leaves: readonly RuntimeSyncedLeaf[]
  existingLeaves: ReadonlyMap<string, RuntimeLeafRecord>
  preserveLivePtysDuringReload: boolean
  getLeafKey: (tabId: string, leafId: string) => string
}): Map<string, string | null> {
  const owners = new Map<string, string | null>()
  for (const leaf of input.leaves) {
    const leafKey = input.getLeafKey(leaf.tabId, leaf.leafId)
    const existing = input.existingLeaves.get(leafKey)
    const ptyId =
      input.preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
        ? existing.ptyId
        : leaf.ptyId
    if (!ptyId) {
      continue
    }
    const priorOwner = owners.get(ptyId)
    owners.set(ptyId, priorOwner === undefined || priorOwner === leafKey ? leafKey : null)
  }
  return owners
}
