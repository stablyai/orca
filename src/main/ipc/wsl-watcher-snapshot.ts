import type { Event as WatcherEvent } from '@parcel/watcher'
import { iterateNulDelimitedFields } from '../../shared/nul-delimited-fields'

export const MAX_WSL_SNAPSHOT_RETAINED_ENTRIES = 50_000

export type WslSnapshotEntry = {
  path: string
  type: string
  mtime: string
}

export type WslSnapshot = Map<string, WslSnapshotEntry>

function toWslUncPath(linuxPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

export function parseWslSnapshotFrame(frame: string, distro: string): WslSnapshot | null {
  const snapshot: WslSnapshot = new Map()
  for (const rawEntry of iterateNulDelimitedFields(frame)) {
    if (!rawEntry) {
      continue
    }
    const firstTab = rawEntry.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : rawEntry.indexOf('\t', firstTab + 1)
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      continue
    }
    const linuxPath = rawEntry.slice(secondTab + 1)
    if (!linuxPath.startsWith('/')) {
      continue
    }
    const path = toWslUncPath(linuxPath, distro)
    if (!snapshot.has(path) && snapshot.size >= MAX_WSL_SNAPSHOT_RETAINED_ENTRIES) {
      return null
    }
    snapshot.set(path, {
      type: rawEntry.slice(0, firstTab),
      mtime: rawEntry.slice(firstTab + 1, secondTab),
      path
    })
  }
  return snapshot
}

export function diffWslSnapshots(prev: WslSnapshot, next: WslSnapshot): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [entryPath, nextEntry] of next) {
    const prevEntry = prev.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.type !== nextEntry.type) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.mtime !== nextEntry.mtime) {
      events.push({ type: 'update', path: entryPath } as WatcherEvent)
    }
  }

  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
    }
  }

  return events
}
