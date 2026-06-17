import { stat } from 'fs/promises'
import * as path from 'path'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent } from '../../shared/types'

export type CoalescedWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export function normalizeWatcherEventPath(eventPath: string): string {
  let resolved = path.resolve(eventPath)
  // Why: on Windows, watcher events may report lowercase drive letters while
  // stored worktree paths use uppercase. Normalizing keeps renderer cache keys
  // casing-consistent.
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

export function coalesceWatcherEvents(raw: readonly WatcherEvent[]): CoalescedWatcherEvent[] {
  const lastByPath = new Map<string, CoalescedWatcherEvent & { index: number }>()
  const deleteBeforeCreate = new Set<string>()

  for (let i = 0; i < raw.length; i += 1) {
    const evt = raw[i]
    const p = normalizeWatcherEventPath(evt.path)
    const prev = lastByPath.get(p)

    if (prev) {
      if (prev.type === 'delete' && evt.type === 'create') {
        deleteBeforeCreate.add(p)
      }
      if (prev.type === 'create' && evt.type === 'delete') {
        lastByPath.delete(p)
        deleteBeforeCreate.delete(p)
        continue
      }
    }

    lastByPath.set(p, { type: evt.type, path: p, index: i })

    // Why: if a later event supersedes delete -> create, emitting the stale
    // delete would invalidate a path that exists again.
    if (evt.type !== 'create' && deleteBeforeCreate.has(p)) {
      deleteBeforeCreate.delete(p)
    }
  }

  const result: CoalescedWatcherEvent[] = []
  for (const p of deleteBeforeCreate) {
    result.push({ type: 'delete', path: p })
  }
  for (const { type, path: eventPath } of lastByPath.values()) {
    result.push({ type, path: eventPath })
  }
  return result
}

async function tryStatIsDirectory(filePath: string): Promise<boolean | undefined> {
  try {
    const s = await stat(filePath)
    return s.isDirectory()
  } catch {
    // Why: vanished/permission-denied paths should invalidate conservatively
    // without pretending the changed entry is definitely a file.
    return undefined
  }
}

export async function mapWatcherEventsToFsChangeEvents(
  events: readonly CoalescedWatcherEvent[]
): Promise<FsChangeEvent[]> {
  return Promise.all(
    events.map(async (evt) => {
      const isDirectory = evt.type === 'delete' ? undefined : await tryStatIsDirectory(evt.path)

      return {
        kind: evt.type,
        absolutePath: evt.path,
        isDirectory
      }
    })
  )
}
