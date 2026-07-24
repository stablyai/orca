import type { TerminalWebViewCommand } from './terminal-webview-messages'

const MAX_PENDING_WEB_WRITE_BYTES = 1_000_000
const MAX_PENDING_WEB_WRITE_MESSAGES = 4096
export const MAX_PENDING_WEB_MESSAGES = 8192

export function createTerminalWebViewPendingMessages() {
  let pending: TerminalWebViewCommand[] = []
  let pendingWriteBytes = 0
  let pendingWriteCount = 0

  const resetCounters = () => {
    pendingWriteBytes = 0
    pendingWriteCount = 0
  }

  const clear = () => {
    pending = []
    resetCounters()
  }

  const removeAt = (index: number) => {
    const [removed] = pending.splice(index, 1)
    if (removed?.type === 'write') {
      pendingWriteBytes = Math.max(0, pendingWriteBytes - removed.data.length)
      pendingWriteCount = Math.max(0, pendingWriteCount - 1)
    }
  }

  const supersedePendingInit = (msg: Extract<TerminalWebViewCommand, { type: 'init' }>) => {
    const existingIndex = pending.findIndex((candidate) => candidate.type === 'init')
    if (existingIndex === -1) {
      return false
    }
    while (pending.length > existingIndex) {
      removeAt(pending.length - 1)
    }
    pending.push(msg)
    return true
  }

  const trimMessageCount = () => {
    while (pending.length > MAX_PENDING_WEB_MESSAGES) {
      const controlIndex = pending.findIndex(
        (candidate) => candidate.type !== 'write' && candidate.type !== 'init'
      )
      removeAt(Math.max(controlIndex, 0))
    }
  }

  const queue = (msg: TerminalWebViewCommand) => {
    if (msg.type === 'init' && supersedePendingInit(msg)) {
      return
    }
    pending.push(msg)
    if (msg.type !== 'write') {
      trimMessageCount()
      return
    }

    pendingWriteBytes += msg.data.length
    pendingWriteCount += 1
    while (
      pendingWriteBytes > MAX_PENDING_WEB_WRITE_BYTES ||
      pendingWriteCount > MAX_PENDING_WEB_WRITE_MESSAGES
    ) {
      const dropIndex = pending.findIndex((candidate) => candidate.type === 'write')
      if (dropIndex === -1) {
        resetCounters()
        return
      }
      removeAt(dropIndex)
    }
    trimMessageCount()
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
