import { optionalNumberParam } from './desktop-script-provider-params'
import type { BridgeSnapshot } from './desktop-script-provider-types'
import {
  lookupCachedSnapshotKey,
  MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS,
  MAX_CACHED_DESKTOP_SNAPSHOTS,
  snapshotCacheKeys,
  type CachedSnapshotEntry,
  staleWindowTargetKeys
} from './desktop-script-snapshot-cache'
import { snapshotWithoutScreenshot } from './desktop-script-snapshot-rendering'

export class DesktopScriptSnapshotStore {
  readonly snapshots = new Map<string, BridgeSnapshot>()
  private readonly snapshotEntries: CachedSnapshotEntry[] = []

  clear(): void {
    this.snapshots.clear()
    this.snapshotEntries.length = 0
  }

  remember(query: string, snapshot: BridgeSnapshot, params: Record<string, unknown>): void {
    const keys = snapshotCacheKeys(query, snapshot, params)
    if (keys.length === 0) {
      return
    }

    // Why: cached snapshots only supply element identity for follow-up actions;
    // retaining PNG base64 across agent loops grows the long-lived sidecar.
    const cachedSnapshot = snapshotWithoutScreenshot(snapshot)
    const entry = { snapshot: cachedSnapshot, keys, createdAtMs: Date.now() }
    this.snapshotEntries.push(entry)
    for (const key of keys) {
      this.snapshots.set(key, cachedSnapshot)
    }
    this.prune()
  }

  current(
    app: string,
    windowId: number | undefined,
    params: Record<string, unknown>
  ): BridgeSnapshot | null {
    this.prune()
    const windowIndex = optionalNumberParam(params, 'windowIndex')
    const keys = lookupCachedSnapshotKey(app, params, windowId, windowIndex)
    const hasExplicitWindowTarget = windowId !== undefined || windowIndex !== undefined
    for (const key of keys) {
      if (
        hasExplicitWindowTarget &&
        !key.includes('#window') &&
        !key.includes('window-id:') &&
        !key.includes('window-index:')
      ) {
        continue
      }
      const cached = this.snapshots.get(key)
      if (cached) {
        return cached
      }
    }
    return null
  }

  forgetWindowTarget(
    query: string,
    params: Record<string, unknown>,
    snapshot: BridgeSnapshot | null
  ): void {
    const keys = staleWindowTargetKeys(query, params, snapshot)
    for (const key of keys) {
      this.snapshots.delete(key)
    }
  }

  private prune(): void {
    while (
      this.snapshotEntries.length > 0 &&
      (this.snapshotEntries.length > MAX_CACHED_DESKTOP_SNAPSHOTS ||
        this.isExpired(this.snapshotEntries[0]))
    ) {
      const expired = this.snapshotEntries.shift()
      if (!expired) {
        return
      }
      for (const key of expired.keys) {
        // Why: newer snapshots can reuse the same alias; only remove aliases
        // that still point at the large snapshot payload being evicted.
        if (this.snapshots.get(key) === expired.snapshot) {
          this.snapshots.delete(key)
        }
      }
    }
  }

  private isExpired(entry: CachedSnapshotEntry): boolean {
    return Date.now() - entry.createdAtMs > MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS
  }
}
