import type { FsChangeEvent } from '../../../../shared/types'

const FILE_WATCH_FLUSH_MS = 150
const FILE_WATCH_MAX_WAIT_MS = 500

export function createFileWatchEventBatcher(
  worktree: string,
  emit: (result: unknown) => void
): {
  push: (events: FsChangeEvent[]) => void
  flush: () => void
  dispose: () => void
} {
  let events: FsChangeEvent[] = []
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
      events.push(...nextEvents)
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
      firstEventAt = 0
    }
  }
}
