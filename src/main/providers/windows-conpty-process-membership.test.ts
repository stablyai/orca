import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { readWindowsConptyProcessIds } from './windows-conpty-process-membership'

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

describe('readWindowsConptyProcessIds', () => {
  it('returns exact console membership from the fixed node-pty helper', async () => {
    const { forkProcess } = forkWith('message', [999, 101, 202, 303], 999)

    await expect(
      readWindowsConptyProcessIds(101, {
        forkProcess,
        resolveAgentPath: () => '/fixed/node-pty/conpty_console_list_agent.js'
      })
    ).resolves.toEqual(new Set([101, 202, 303]))
    expect(forkProcess).toHaveBeenCalledWith(
      '/fixed/node-pty/conpty_console_list_agent.js',
      ['101'],
      { silent: true }
    )
  })

  it.each([
    ['root-only failure fallback', [101], 999],
    ['malformed response', [999, 101, '202'], 999],
    ['missing PTY root', [999, 202, 303], 999],
    ['missing helper pid', [101, 202], 999],
    ['unavailable helper pid', [101, 202], undefined]
  ])('fails closed for %s', async (_label, processIds, helperPid) => {
    const { forkProcess } = forkWith('message', processIds, helperPid)
    await expect(readWindowsConptyProcessIds(101, { forkProcess })).resolves.toBeNull()
  })

  it('returns root-only membership when only the helper and shell are attached', async () => {
    const { forkProcess } = forkWith('message', [999, 101], 999)
    await expect(readWindowsConptyProcessIds(101, { forkProcess })).resolves.toEqual(new Set([101]))
  })

  it('reports membership excluding the helper when a real child is attached', async () => {
    const { forkProcess } = forkWith('message', [999, 101, 202], 999)
    await expect(readWindowsConptyProcessIds(101, { forkProcess })).resolves.toEqual(
      new Set([101, 202])
    )
  })

  it('handles helper spawn errors without an unhandled child error', async () => {
    const { forkProcess } = forkWith('error')
    await expect(readWindowsConptyProcessIds(101, { forkProcess })).resolves.toBeNull()
  })

  it('kills a silent helper at the bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      const result = readWindowsConptyProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('absorbs an asynchronous kill error after timeout settlement', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      child.kill.mockImplementation(() => {
        queueMicrotask(() => child.emit('error', new Error('kill failed')))
      })
      const result = readWindowsConptyProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
