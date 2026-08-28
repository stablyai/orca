import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'

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

// Unlike local coalescing, a recreate keeps its delete through live updates so cached dirs are purged;
// delete→create→delete also remains a net delete because the path predated the batch.
function posixEventIdentity(absolutePath: string): string {
  const normalized = absolutePath.replace(/\/+/g, '/')
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

function coalesceRemoteEvents(raw: FsChangeEvent[], rootPath: string): FsChangeEvent[] {
  const lastByKey = new Map<string, FsChangeEvent>()
  const deleteBeforeCreate = new Map<string, FsChangeEvent>()
  const passthrough: FsChangeEvent[] = []
  const windowsPaths = isWindowsAbsolutePathLike(rootPath)

  for (const event of raw) {
    if (event.kind !== 'create' && event.kind !== 'update' && event.kind !== 'delete') {
      // Why: 'rename' has no producer on this transport; forward it untouched rather than invent a rule.
      passthrough.push(event)
      continue
    }
    // POSIX event identity keeps byte-distinct names; Windows still folds separators and casing.
    const key = windowsPaths
      ? normalizeRuntimePathForComparison(event.absolutePath)
      : posixEventIdentity(event.absolutePath)
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

    // A final delete subsumes the transition; a live update cannot prove the old entry was not a directory.
    if (event.kind === 'delete') {
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
    const coalesced = coalesceRemoteEvents(pending, rootPath)
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
