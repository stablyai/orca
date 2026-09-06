import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_INPUT_MAX_BYTES } from '../../shared/terminal-input'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  captureTerminalInputArrivalWriteGuard,
  runTerminalInputInArrivalOrder
} from './terminal-input-arrival'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const generations = new Map([
    ['pty-1', 1],
    ['pty-2', 1]
  ])
  const bindings = new Map([
    ['one', 'pty-1'],
    ['alias', 'pty-1'],
    ['two', 'pty-2']
  ])
  const writes: string[] = []
  const runtime = {
    captureTerminalInputArrivalTarget: (handle: string) => {
      const ptyId = bindings.get(handle)!
      const generation = generations.get(ptyId)!
      return {
        ptyId,
        generation,
        assertCurrent: () => {
          if (bindings.get(handle) !== ptyId || generations.get(ptyId) !== generation) {
            throw new Error('terminal_handle_stale')
          }
        }
      }
    }
  }
  const writer = new RuntimeTerminalWriter(
    (pty, text) => {
      writes.push(`${pty}:${text}`)
      return true
    },
    () => 'linux',
    (pty, initialize) => {
      if (initialize && !generations.has(pty)) {
        generations.set(pty, 99)
      }
      return generations.get(pty)
    }
  )
  const send = (handle: string, text: string, hold?: Promise<void>, signal?: AbortSignal) =>
    runTerminalInputInArrivalOrder(runtime, handle, text.length, signal, async () => {
      await hold
      await writer.writeAction(bindings.get(handle)!, { text }, text, { signal })
    })
  return { runtime, writer, writes, send, bindings, generations }
}

describe('terminal input arrival lane', () => {
  it('holds later alias input behind first validation without blocking another PTY', async () => {
    const f = fixture()
    const held = deferred()
    const first = f.send('one', 'text', held.promise)
    const enter = f.send('alias', '\r')
    await f.send('two', 'independent')
    expect(f.writes).toEqual(['pty-2:independent'])
    held.resolve()
    await Promise.all([first, enter])
    expect(f.writes).toEqual(['pty-2:independent', 'pty-1:text', 'pty-1:\r'])
  })

  it.each(['generation', 'binding', 'reaped'] as const)(
    'rejects active and queued input after a %s change',
    async (change) => {
      const f = fixture()
      const held = deferred()
      const first = f.send('one', 'text', held.promise)
      const second = f.send('one', '\r')
      const results = Promise.allSettled([first, second])
      if (change === 'generation') {
        f.generations.set('pty-1', 2)
      }
      if (change === 'binding') {
        f.bindings.set('one', 'pty-2')
      }
      if (change === 'reaped') {
        f.generations.delete('pty-1')
      }
      held.resolve()
      expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected'])
      expect(f.writes).toEqual([])
      if (change === 'reaped') {
        expect(f.generations.has('pty-1')).toBe(false)
      }
    }
  )

  it('a replacement generation does not wait for its predecessor', async () => {
    const f = fixture()
    const held = deferred()
    const old = f.send('one', 'old', held.promise).catch((e: Error) => e.message)
    f.generations.set('pty-1', 2)
    await f.send('one', 'new')
    expect(f.writes).toEqual(['pty-1:new'])
    held.resolve()
    expect(await old).toBe('terminal_handle_stale')
  })

  it('releases queued cancellation capacity immediately and never starts canceled work', async () => {
    const f = fixture()
    const held = deferred()
    const first = f.send('one', 'first', held.promise)
    const abort = new AbortController()
    const canceledRun = vi.fn(async () => {})
    const canceled = runTerminalInputInArrivalOrder(
      f.runtime,
      'one',
      TERMINAL_INPUT_MAX_BYTES - 5,
      abort.signal,
      canceledRun
    ).catch((e: Error) => e.message)
    await expect(f.send('one', 'overflow')).rejects.toThrow('terminal_input_queue_full')
    abort.abort()
    expect(await canceled).toBe('request_aborted')
    const live = f.send('one', 'live')
    held.resolve()
    await Promise.all([first, live])
    expect(canceledRun).not.toHaveBeenCalled()
    expect(f.writes).toEqual(['pty-1:first', 'pty-1:live'])
  })

  it('cancels an active validation before any provider write', async () => {
    const f = fixture()
    const held = deferred()
    const abort = new AbortController()
    const send = f.send('one', 'text', held.promise, abort.signal)
    const result = send.catch((e: Error) => e.message)
    abort.abort()
    held.resolve()
    expect(await result).toBe('request_aborted')
    expect(f.writes).toEqual([])
  })

  it('captures each write guard before the lower-level writer queue changes async context', async () => {
    const f = fixture()
    let guard!: (ptyId: string) => void
    await runTerminalInputInArrivalOrder(f.runtime, 'one', 1, undefined, async () => {
      guard = captureTerminalInputArrivalWriteGuard()
    })
    f.generations.set('pty-1', 2)
    expect(() => guard('pty-1')).toThrow('terminal_handle_stale')
  })

  it('pins the lease before validation instead of admitting a new lease after waiting', async () => {
    const f = fixture()
    const held = deferred()
    let fence = 1
    const admit = vi.spyOn(agentSessionPtyWriteGate, 'admit').mockImplementation(() => ({
      admitted: true,
      sessionId: 'session-1',
      runtimeFence: fence
    }))
    const readmit = vi
      .spyOn(agentSessionPtyWriteGate, 'assertReadmitted')
      .mockImplementation((_pty, admission) => {
        if (admission.runtimeFence !== fence) {
          throw new Error('lease_changed')
        }
      })
    try {
      const first = f.send('one', 'old lease', held.promise)
      fence = 2
      held.resolve()
      await expect(first).rejects.toThrow('lease_changed')
      expect(f.writes).toEqual([])
      await f.send('one', 'new lease')
      expect(f.writes).toEqual(['pty-1:new lease'])
    } finally {
      admit.mockRestore()
      readmit.mockRestore()
    }
  })

  it('bounds pending call count independently of retained text bytes', async () => {
    const f = fixture()
    const held = deferred()
    const first = f.send('one', 'first', held.promise)
    const pending = Array.from({ length: 1023 }, () => f.send('one', 'x'))
    await expect(f.send('one', 'overflow')).rejects.toThrow('terminal_input_queue_full')
    expect(f.writes).toEqual([])
    held.resolve()
    await Promise.all([first, ...pending])
    expect(f.writes).toHaveLength(1024)
  })
})
