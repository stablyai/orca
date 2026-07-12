import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { readWindowsConptyProcessIds } from './windows-conpty-process-membership'

function forkWith(event: 'message' | 'error' | 'none', value?: unknown) {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  child.kill = vi.fn()
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
    const { forkProcess } = forkWith('message', [101, 202, 303])

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
    ['root-only failure fallback', [101]],
    ['malformed response', [101, '202']],
    ['missing PTY root', [202, 303]]
  ])('fails closed for %s', async (_label, processIds) => {
    const { forkProcess } = forkWith('message', processIds)
    await expect(readWindowsConptyProcessIds(101, { forkProcess })).resolves.toBeNull()
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
})
