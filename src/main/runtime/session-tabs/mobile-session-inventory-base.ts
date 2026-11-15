import type { BrowserPageInventoryEntry } from '../../../shared/browser/runtime/browser-page-inventory'
import type {
  RuntimeMobileSessionTabsPublication,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

type AcceptedInventoryBase = {
  publicationEpoch: string
  rendererVersion: number
  worktreeInstanceId?: string
  browserPageInventory?: BrowserPageInventoryEntry[]
}

/** The snapshot a renderer frame stands for, or null when its base is not the accepted publication. */
export function withAcceptedBrowserPageInventory(
  frame: RuntimeMobileSessionTabsPublication,
  accepted: AcceptedInventoryBase | undefined
): RuntimeMobileSessionTabsSnapshot | null {
  if (!('browserPageInventoryBaseVersion' in frame)) {
    return frame
  }
  // The transport hint never reaches stored or outward snapshots.
  const { browserPageInventoryBaseVersion: baseVersion, ...snapshot } = frame
  if (baseVersion === undefined) {
    return snapshot
  }
  if (
    accepted?.browserPageInventory === undefined ||
    accepted.publicationEpoch !== snapshot.publicationEpoch ||
    accepted.worktreeInstanceId !== snapshot.worktreeInstanceId ||
    accepted.rendererVersion !== baseVersion ||
    baseVersion >= snapshot.snapshotVersion
  ) {
    return null
  }
  return { ...snapshot, browserPageInventory: accepted.browserPageInventory }
}
