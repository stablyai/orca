import type { FsChangeEvent } from '../../shared/types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type RemoteWatcherEventBatchOptions = {
  rootPath: string
  deliver: (events: FsChangeEvent[]) => void
  trailingMs: number
  maxWaitMs: number
  maxEvents: number
}

export type RemoteWatcherEventBatch = {
  push: (events: FsChangeEvent[]) => void
  close: () => void
}

// Mirrors coalesceEvents in filesystem-watcher.ts, with two deliberate divergences: a hoisted delete
// survives a later event of unknown isDirectory, so delete→create→update over-emits a delete; and
// delete→create→delete emits that delete, which local drops — the path is gone, so the renderer needs it.
function coalesceRemoteEvents(raw: FsChangeEvent[]): FsChangeEvent[] {
  const lastByKey = new Map<string, FsChangeEvent>()
  const deleteBeforeCreate = new Map<string, FsChangeEvent>()
  const passthrough: FsChangeEvent[] = []

  for (const event of raw) {
    if (event.kind !== 'create' && event.kind !== 'update' && event.kind !== 'delete') {
      // Why: 'rename' has no producer on this transport; forward it untouched rather than invent a rule.
      passthrough.push(event)
      continue
    }
    // Why: key on the comparison form, never node path.resolve — resolving a remote POSIX path on a
    // Windows host mints C:\home\u\f, which the renderer's watch canonicalizer then rejects outright.
    // Residual cost: its NFC fold merges canonically equivalent byte-distinct names on a POSIX host.
    const key = normalizeRuntimePathForComparison(event.absolutePath)
    const prev = lastByKey.get(key)

    if (prev) {
      if (prev.kind === 'delete' && event.kind === 'create') {
        deleteBeforeCreate.set(key, prev)
      }
      if (prev.kind === 'create' && event.kind === 'delete') {
        // Why: cancel only a path created and removed entirely inside the window; an earlier delete means
        // the file predates it, so the window nets out to a delete the renderer still has to act on.
        const netNoOp = !deleteBeforeCreate.delete(key)
        if (netNoOp) {
          lastByKey.delete(key)
          continue
        }
      }
    }

    lastByKey.set(key, event)

    // Why: drop the hoisted delete only when the later event proves the path is a live file, or repeats the
    // delete. Remote events carry no isDirectory, and discarding it there strands a dead dir's cached subtree.
    if (event.kind === 'delete' || (event.kind === 'update' && event.isDirectory === false)) {
      deleteBeforeCreate.delete(key)
    }
  }

  return [...deleteBeforeCreate.values(), ...lastByKey.values(), ...passthrough]
}

export function createRemoteWatcherEventBatch({
  rootPath,
  deliver,
  trailingMs,
  maxWaitMs,
  maxEvents
}: RemoteWatcherEventBatchOptions): RemoteWatcherEventBatch {
  let buffered: FsChangeEvent[] = []
  let overflowed = false
  let firstEventAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const pending = buffered
    const latched = overflowed
    buffered = []
    overflowed = false
    firstEventAt = 0

    if (latched) {
      deliver([{ kind: 'overflow', absolutePath: rootPath }])
      return
    }
    const coalesced = coalesceRemoteEvents(pending)
    if (coalesced.length > 0) {
      deliver(coalesced)
    }
  }

  function schedule(): void {
    const now = Date.now()
    if (firstEventAt === 0) {
      firstEventAt = now
    }
    if (now - firstEventAt >= maxWaitMs) {
      flush()
      return
    }
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(flush, trailingMs)
  }

  return {
    push(events) {
      // Why: an in-flight provider receive can land after teardown; re-arming there would strand a timer.
      if (closed) {
        return
      }
      if (!overflowed) {
        if (
          buffered.length + events.length > maxEvents ||
          events.some((event) => event.kind === 'overflow')
        ) {
          // Why: past the cap precision only burns memory; one overflow buys the same conservative refresh.
          buffered = []
          overflowed = true
        } else {
          // Why: a deletion storm can exceed V8's argument limit for push(...events).
          for (const event of events) {
            buffered.push(event)
          }
        }
      }
      schedule()
    },
    close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      buffered = []
      overflowed = false
      firstEventAt = 0
    }
  }
}
