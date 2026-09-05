import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

function barrier() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

afterEach(() => vi.restoreAllMocks())

describe('terminal writer ordering', () => {
  it.each(['Z', '\r'])('keeps a later %j after every chunk of a paste', async (later) => {
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((_pty, text) => {
      writes.push(text)
      return true
    })
    const paste = 'a'.repeat(20_000)
    await Promise.all([
      writer.writeAction('pty', { text: paste }, paste),
      writer.writeAction('pty', { text: later }, later)
    ])
    expect(writes.join('').indexOf(later)).toBe(paste.length)
    expect(writes.join('')).toBe(paste + later)
  })

  it('recovers after rejection without blocking a different terminal', async () => {
    const blocked = barrier()
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((pty, text) => {
      writes.push(`${pty}:${text}`)
      return true
    })
    const first = writer.writeAction('one', { text: 'bad' }, 'bad', {
      beforeWrite: async () => {
        await blocked.promise
        throw new Error('rejected')
      }
    })
    const rejected = expect(first).rejects.toThrow('rejected')
    const next = writer.writeAction('one', { text: 'good' }, 'good')
    await writer.writeAction('two', { text: 'independent' }, 'independent')
    expect(writes).toEqual(['two:independent'])
    blocked.release()
    await rejected
    await next
    expect(writes).toEqual(['two:independent', 'one:good'])
  })

  it('keeps the admitted lease identity across the queue wait', async () => {
    const blocked = barrier()
    let fence = 1
    vi.spyOn(agentSessionPtyWriteGate, 'assertAdmitted').mockImplementation(() => ({
      sessionId: 'session',
      runtimeFence: fence
    }))
    vi.spyOn(agentSessionPtyWriteGate, 'assertReadmitted').mockImplementation((_pty, admitted) => {
      if (admitted.runtimeFence !== fence) {
        throw new Error('stale fence')
      }
    })
    const write = vi.fn(() => true)
    const writer = new RuntimeTerminalWriter(write)
    const first = writer.writeAction('pty', { text: 'first' }, 'first', {
      afterWrite: () => blocked.promise
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    const next = writer.writeAction('pty', { text: 'stale' }, 'stale')
    const rejected = expect(next).rejects.toThrow('stale fence')
    fence = 2
    blocked.release()
    await first
    await rejected
    expect(write).toHaveBeenCalledOnce()
  })

  it('rejects queued writes from an old PTY generation while the replacement proceeds', async () => {
    const blocked = barrier()
    let generation = 1
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter(
      (_pty, text) => {
        writes.push(text)
        return true
      },
      () => 'linux',
      () => generation
    )
    const first = writer.writeAction('pty', { text: 'first' }, 'first', {
      afterWrite: () => blocked.promise
    })
    await vi.waitFor(() => expect(writes).toEqual(['first']))
    const queued = writer.writeAction('pty', { text: 'stale' }, 'stale')
    const rejected = expect(queued).rejects.toThrow('terminal_handle_stale')
    generation = 2
    await writer.writeAction('pty', { text: 'new' }, 'new')
    blocked.release()
    await first
    await rejected
    expect(writes).toEqual(['first', 'new'])
  })

  it('drops an aborted queued write and clears drained queue state', async () => {
    const blocked = barrier()
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((_pty, text) => {
      writes.push(text)
      return true
    })
    const first = writer.writeAction('pty', { text: 'first' }, 'first', {
      afterWrite: () => blocked.promise
    })
    const abort = new AbortController()
    const queued = writer.writeAction('pty', { text: 'cancelled' }, 'cancelled', {
      signal: abort.signal
    })
    const rejected = expect(queued).rejects.toThrow('request_aborted')
    abort.abort()
    blocked.release()
    await first
    await rejected
    expect(writes).toEqual(['first'])
    await vi.waitFor(() =>
      expect(
        (writer as unknown as { writes: { queues: Map<string, unknown> } }).writes.queues.size
      ).toBe(0)
    )
  })

  it('serializes direct chunk writes with actions without nesting queue waits', async () => {
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((_pty, text) => {
      writes.push(text)
      return true
    })
    const paste = 'a'.repeat(20_000)
    await Promise.all([
      writer.writeChunks('pty', paste),
      writer.writeAction('pty', { enter: true }, '\r')
    ])
    expect(writes.join('').indexOf('\r')).toBe(paste.length)
  })

  it('bounds pending writes and releases capacity after draining', async () => {
    const blocked = barrier()
    const writer = new RuntimeTerminalWriter(() => true)
    const first = writer.writeAction('pty', { text: 'first' }, 'first', {
      afterWrite: () => blocked.promise
    })
    const queued = Array.from({ length: 1023 }, () => writer.writeAction('pty', { text: 'x' }, 'x'))
    await expect(writer.writeAction('pty', { text: 'overflow' }, 'overflow')).rejects.toThrow(
      'terminal_input_queue_full'
    )
    blocked.release()
    await Promise.all([first, ...queued])
    await expect(writer.writeAction('pty', { text: 'fresh' }, 'fresh')).resolves.toBeUndefined()
    await vi.waitFor(() =>
      expect(
        (writer as unknown as { writes: { retainedCallBytes: number } }).writes.retainedCallBytes
      ).toBe(0)
    )
  })

  it('bounds retained text before admitting another paste', async () => {
    const blocked = barrier()
    const abort = new AbortController()
    const write = vi.fn(() => true)
    const writer = new RuntimeTerminalWriter(write)
    const paste = 'a'.repeat(9 * 1024 * 1024)
    const first = writer.writeAction('pty', { text: paste }, paste, {
      signal: abort.signal,
      beforeWrite: () => blocked.promise
    })
    const aborted = expect(first).rejects.toThrow('request_aborted')
    await expect(writer.writeAction('pty', { text: paste }, paste)).rejects.toThrow(
      'terminal_input_queue_full'
    )
    abort.abort()
    blocked.release()
    await aborted
    expect(write).not.toHaveBeenCalled()
    await expect(writer.writeAction('pty', { text: 'fresh' }, 'fresh')).resolves.toBeUndefined()
  })

  it.each(['generation', 'abort'] as const)(
    'checks %s synchronously after beforeWrite microtasks',
    async (change) => {
      let generation = 1
      const abort = new AbortController()
      const write = vi.fn(() => true)
      const reserveWrite = vi.fn()
      const writer = new RuntimeTerminalWriter(
        write,
        () => 'linux',
        () => generation
      )
      const sending = writer.writeAction('pty', { text: 'old' }, 'old', {
        signal: abort.signal,
        reserveWrite,
        beforeWrite: () => {
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (change === 'generation') {
                generation = 2
              } else {
                abort.abort()
              }
            })
          )
        }
      })
      await expect(sending).rejects.toThrow(
        change === 'generation' ? 'terminal_handle_stale' : 'request_aborted'
      )
      expect(reserveWrite).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    }
  )

  it('reclaims 1023 aborted queued writes before the blocked head finishes', async () => {
    const blocked = barrier()
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((_pty, text) => {
      writes.push(text)
      return true
    })
    const head = writer.writeAction('pty', { text: 'head' }, 'head', {
      afterWrite: () => blocked.promise
    })
    const controllers = Array.from({ length: 1023 }, () => new AbortController())
    const queued = controllers.map((controller) =>
      writer.writeAction('pty', { text: 'cancelled' }, 'cancelled', { signal: controller.signal })
    )
    let rejectedCount = 0
    queued.forEach((pending) => {
      void pending.catch(() => {
        rejectedCount += 1
      })
    })
    controllers.forEach((controller) => controller.abort())
    const fresh = writer.writeAction('pty', { text: 'fresh' }, 'fresh')
    const freshResult = fresh.catch((error: unknown) => error)
    await vi.waitFor(() => expect(rejectedCount).toBe(1023), { timeout: 100 })
    const pool = (
      writer as unknown as { writes: { queuedCallCount: number; retainedCallBytes: number } }
    ).writes
    expect(pool.queuedCallCount).toBe(1)
    expect(pool.retainedCallBytes).toBe(('head'.length + 'fresh'.length) * 2)
    expect(writes).toEqual(['head'])
    blocked.release()
    await head
    expect(await freshResult).toBeUndefined()
    expect(writes).toEqual(['head', 'fresh'])
  })

  it('does not recreate a reaped generation during a delayed write check', async () => {
    const generations = new Map<string, number>()
    const write = vi.fn(() => true)
    const writer = new RuntimeTerminalWriter(
      write,
      () => 'linux',
      (ptyId, initialize) => {
        if (initialize && !generations.has(ptyId)) {
          generations.set(ptyId, 1)
        }
        return generations.get(ptyId)
      }
    )
    await expect(
      writer.writeAction('pty', { text: 'old' }, 'old', {
        beforeWrite: () => {
          generations.delete('pty')
        }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(generations.size).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  it('checks generation again after a synchronous reservation callback', async () => {
    let generation = 1
    const write = vi.fn(() => true)
    const writer = new RuntimeTerminalWriter(
      write,
      () => 'linux',
      () => generation
    )
    await expect(
      writer.writeAction('pty', { enter: true }, '\r', {
        reserveWrite: () => {
          generation = 2
        }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(write).not.toHaveBeenCalled()
  })
})
