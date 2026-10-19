import type { TerminalWebViewCommand } from './terminal-webview-messages'

const MAX_PENDING_WEB_WRITE_CODE_UNITS = 1_000_000
const MAX_PENDING_WEB_WRITE_MESSAGES = 4096

export function createTerminalWebViewPendingMessages() {
  let pending: TerminalWebViewCommand[] = []
  let pendingWriteCodeUnits = 0
  let pendingWriteCount = 0

  const resetCounters = () => {
    pendingWriteCodeUnits = 0
    pendingWriteCount = 0
  }

  const clear = () => {
    pending = []
    resetCounters()
  }

  const queue = (msg: TerminalWebViewCommand) => {
    pending.push(msg)
    if (msg.type !== 'write') {
      return
    }

    pendingWriteCodeUnits += msg.data.length
    pendingWriteCount += 1
    while (
      pendingWriteCodeUnits > MAX_PENDING_WEB_WRITE_CODE_UNITS ||
      pendingWriteCount > MAX_PENDING_WEB_WRITE_MESSAGES
    ) {
      const dropIndex = pending.findIndex((candidate) => candidate.type === 'write')
      if (dropIndex === -1) {
        resetCounters()
        return
      }
      const [dropped] = pending.splice(dropIndex, 1)
      if (dropped?.type === 'write') {
        pendingWriteCodeUnits = Math.max(0, pendingWriteCodeUnits - dropped.data.length)
        pendingWriteCount = Math.max(0, pendingWriteCount - 1)
      }
    }
  }

  const flush = (send: (msg: TerminalWebViewCommand) => void) => {
    const messages = pending
    clear()
    for (const msg of messages) {
      send(msg)
    }
  }

  return { clear, flush, queue }
}
