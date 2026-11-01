import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'

function forkWith(event: 'message' | 'error' | 'none', value?: unknown, pid?: number) {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>
    pid?: number
  }
  child.kill = vi.fn()
  if (pid !== undefined) {
    child.pid = pid
  }
  const forkProcess = vi.fn(() => {
    queueMicrotask(() => {
      if (event === 'message') {
        child.emit('message', { consoleProcessList: value })
      } else if (event === 'error') {
        child.emit('error', new Error('spawn failed'))
      }
    })
    return child
  })
  return { child, forkProcess: forkProcess as never }
}

describe('readWindowsConsoleAttachedProcessIds', () => {
  it('absorbs an asynchronous kill error after timeout settlement', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      child.kill.mockImplementation(() => {
        queueMicrotask(() => child.emit('error', new Error('kill failed')))
      })
      const result = readWindowsConsoleAttachedProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
