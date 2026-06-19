import type { FsChangeEvent } from '../../../../shared/types'

const FILE_WATCH_FLUSH_MS = 150
const FILE_WATCH_MAX_WAIT_MS = 500
const MAX_FILE_WATCH_BATCH_EVENTS = 5_000

export function createFileWatchEventBatcher(
  worktree: string,
  emit: (result: unknown) => void
): {
  push: (events: FsChangeEvent[]) => void
  flush: () => void
  dispose: () => void
} {
  let events: FsChangeEvent[] = []
  let overflowed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstEventAt = 0

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    const nextEvents = events.splice(0)
    overflowed = false
    firstEventAt = 0
    if (nextEvents.length === 0) {
      return
    }
    emit({ type: 'changed', worktree, events: nextEvents })
  }

  return {
    push(nextEvents: FsChangeEvent[]): void {
      if (nextEvents.length === 0) {
        return
      }
      if (!overflowed) {
        const incomingOverflow = nextEvents.find((event) => event.kind === 'overflow')
        if (incomingOverflow) {
          events = [incomingOverflow]
          overflowed = true
        } else if (events.length + nextEvents.length > MAX_FILE_WATCH_BATCH_EVENTS) {
          // Why: once precision is too expensive to retain and stream, one
          // overflow asks clients to refresh safely without a huge payload.
          events = [
            {
              kind: 'overflow',
              absolutePath: nextEvents[0]?.absolutePath ?? events[0]?.absolutePath ?? ''
            }
          ]
          overflowed = true
        } else {
          for (const event of nextEvents) {
            events.push(event)
          }
        }
      }
      const now = Date.now()
      if (firstEventAt === 0) {
        firstEventAt = now
      }
      if (now - firstEventAt >= FILE_WATCH_MAX_WAIT_MS) {
        flush()
        return
      }
      clearTimer()
      // Why: remote file-watch events cross the runtime WebSocket before the
      // renderer refreshes the tree. Match local watcher batching here.
      timer = setTimeout(flush, FILE_WATCH_FLUSH_MS)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
    },
    flush,
    dispose(): void {
      clearTimer()
      events = []
      overflowed = false
      firstEventAt = 0
    }
  }
}
