import {
  browserPageInventorySchema,
  type BrowserPageInventoryEntry
} from '../../../../shared/browser/runtime/browser-page-inventory'
import type {
  RuntimeMobileSessionTabsPublication,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

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

/** Rejects a renderer frame whose browser inventory is malformed or both reused and resent. */
export function assertBrowserPageInventoryFrames(
  snapshots: readonly RuntimeMobileSessionTabsPublication[] | undefined
): void {
  for (const snapshot of snapshots ?? []) {
    const baseVersion = snapshot.browserPageInventoryBaseVersion
    if (
      baseVersion !== undefined
        ? // A base names a reused inventory, so a frame cannot also carry one.
          !Number.isSafeInteger(baseVersion) || snapshot.browserPageInventory !== undefined
        : snapshot.browserPageInventory !== undefined &&
          !browserPageInventorySchema.safeParse(snapshot.browserPageInventory).success
    ) {
      throw new Error('invalid_browser_page_inventory')
    }
  }
}
