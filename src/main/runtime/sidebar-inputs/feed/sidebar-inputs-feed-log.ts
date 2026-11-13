import type { FeedChange, FeedEntity } from './sidebar-inputs-feed-pages'

export const FEED_LOG_MAX_REVISIONS = 256
export const FEED_LOG_MAX_BYTES = 2 * 1024 * 1024

/** Per domain, each changed key's new entity, or null when it was removed. */
export type FeedRevisionChanges = Map<string, Map<string, FeedEntity | null>>

type LogEntry = { revision: number; changes: FeedRevisionChanges; bytes: number }

/** The last revisions' changes, bounded by count and bytes; older cursors read a snapshot. */
export class FeedChangeLog {
  private readonly entries: LogEntry[] = []
  private bytes = 0

  /** `floor` is the revision the log starts from: the oldest cursor it can bring current. */
  constructor(private floor: number) {}

  covers(cursor: number, revision: number): boolean {
    return cursor >= this.floor && cursor <= revision
  }

  append(revision: number, changes: FeedRevisionChanges): void {
    let bytes = 0
    for (const changed of changes.values()) {
      for (const [key, entity] of changed) {
        bytes += key.length + (entity?.bytes ?? 0)
      }
    }
    this.entries.push({ revision, changes, bytes })
    this.bytes += bytes
    while (this.entries.length > FEED_LOG_MAX_REVISIONS || this.bytes > FEED_LOG_MAX_BYTES) {
      const dropped = this.entries.shift()
      if (!dropped) {
        break
      }
      this.bytes -= dropped.bytes
      this.floor = dropped.revision
    }
  }

  /** Every key changed after `cursor`, in its latest form. */
  *since(cursor: number): Iterable<FeedChange> {
    const merged: FeedRevisionChanges = new Map()
    for (const entry of this.entries) {
      if (entry.revision > cursor) {
        for (const [name, changed] of entry.changes) {
          const into = merged.get(name) ?? new Map<string, FeedEntity | null>()
          merged.set(name, into)
          for (const [key, entity] of changed) {
            into.set(key, entity)
          }
        }
      }
    }
    for (const [name, changed] of merged) {
      for (const [key, entity] of changed) {
        yield [name, key, entity]
      }
    }
  }
}
