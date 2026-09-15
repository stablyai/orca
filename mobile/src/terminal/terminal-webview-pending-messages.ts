import type { TerminalWebViewCommand } from './terminal-webview-messages'

const MAX_PENDING_WEB_WRITE_BYTES = 1_000_000
const MAX_PENDING_WEB_WRITE_MESSAGES = 4096
const PENDING_WRITE_COMPACTION_DROPS = 1024

export function createTerminalWebViewPendingMessages() {
  let pending: Array<TerminalWebViewCommand | null> = []
  let pendingWriteBytes = 0
  let pendingWriteCount = 0
  let pendingWriteDropCursor = 0
  let droppedWriteSlots = 0

  const resetQueueState = () => {
    pendingWriteBytes = 0
    pendingWriteCount = 0
    pendingWriteDropCursor = 0
    droppedWriteSlots = 0
  }

  const clear = () => {
    pending = []
    resetQueueState()
  }

  const compactDroppedWrites = () => {
    pending = pending.filter((msg): msg is TerminalWebViewCommand => msg !== null)
    pendingWriteDropCursor = 0
    droppedWriteSlots = 0
  }

  const dropOldestWrite = (): boolean => {
    while (pendingWriteDropCursor < pending.length) {
      const dropIndex = pendingWriteDropCursor
      pendingWriteDropCursor += 1
      const dropped = pending[dropIndex]
      if (dropped?.type !== 'write') {
        continue
      }

      // Why: splice shifts up to 4,096 slots per saturated write. Tombstones make
      // eviction O(1); periodic stable compaction preserves order and bounds memory.
      pending[dropIndex] = null
      pendingWriteBytes -= dropped.data.length
      pendingWriteCount -= 1
      droppedWriteSlots += 1
      if (droppedWriteSlots >= PENDING_WRITE_COMPACTION_DROPS) {
        compactDroppedWrites()
      }
      return true
    }
    return false
  }

  const queue = (msg: TerminalWebViewCommand) => {
    pending.push(msg)
    if (msg.type !== 'write') {
      return
    }

    pendingWriteBytes += msg.data.length
    pendingWriteCount += 1
    while (
      pendingWriteBytes > MAX_PENDING_WEB_WRITE_BYTES ||
      pendingWriteCount > MAX_PENDING_WEB_WRITE_MESSAGES
    ) {
      if (!dropOldestWrite()) {
        resetQueueState()
        return
      }
    }
  }

  const flush = (send: (msg: TerminalWebViewCommand) => void) => {
    const messages = pending
    clear()
    for (const msg of messages) {
      if (msg) {
        send(msg)
      }
    }
  }

  return { clear, flush, queue }
}
