import { describe, expect, it, vi } from 'vitest'
import {
  isTerminalLiveInputWithinByteLimit,
  TERMINAL_LIVE_INPUT_MAX_BYTES
} from './terminal-live-input'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveControlSend,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    const state = createTerminalLivePendingFlushState()

    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })
})

describe('terminal live mirror send queue', () => {
  it.each(['throw', 'reject', 'refuse', 'too-large'] as const)(
    'retires dependent input after a send fails by %s',
    async (failure) => {
      const state = createTerminalLivePendingFlushState()
      const writes: string[] = []
      const onFailure = vi.fn()
      state.onFailure = onFailure
      const sender = (_handle: string, payload: string): Promise<boolean> => {
        writes.push(payload)
        if (writes.length === 1 && failure !== 'too-large') {
          if (failure === 'throw') {
            throw new Error('transport unavailable')
          }
          return failure === 'reject'
            ? Promise.reject(new Error('timeout'))
            : Promise.resolve(false)
        }
        return Promise.resolve(true)
      }
      const first = queueTerminalLiveMirrorSend(
        state,
        'terminal-1',
        failure === 'too-large' ? 'a'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES + 1) : 'first',
        sender
      )
      const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', sender)

      await waitForTerminalLivePendingFlush(state)

      await expect(Promise.all([first, second])).resolves.toEqual([false, false])
      expect(writes).toEqual(failure === 'too-large' ? [] : ['first'])
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        'terminal-1',
        failure === 'too-large' ? 'input-too-large' : 'delivery-unconfirmed'
      )
      expect(state.activeRequests).toEqual([])
      expect(state.pendingBatches).toEqual([])
      await expect(queueTerminalLiveMirrorSend(state, 'terminal-1', 'fresh', sender)).resolves.toBe(
        true
      )
    }
  )

  it.each(['a', '😀'])(
    'keeps coalesced %s input within the live sender byte limit',
    async (glyph) => {
      const state = createTerminalLivePendingFlushState()
      const payloads: string[] = []
      const received: string[] = []
      let release = (_accepted: boolean): void => {}
      const sender = async (_handle: string, payload: string): Promise<boolean> => {
        payloads.push(payload)
        if (payloads.length === 1) {
          return new Promise<boolean>((resolve) => {
            release = resolve
          })
        }
        const accepted = isTerminalLiveInputWithinByteLimit(payload)
        if (accepted) {
          received.push(payload)
        }
        return accepted
      }
      const part = glyph.repeat(
        TERMINAL_LIVE_INPUT_MAX_BYTES / 2 / new TextEncoder().encode(glyph).length
      )
      const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'held', sender)
      const queued = Array.from({ length: 3 }, () =>
        queueTerminalLiveMirrorSend(state, 'terminal-1', part, sender)
      )
      release(true)
      await expect(Promise.all([first, ...queued])).resolves.toEqual([true, true, true, true])
      expect(received.join('')).toBe(part.repeat(3))
      expect(payloads).toHaveLength(3)
      expect(payloads.every((payload) => isTerminalLiveInputWithinByteLimit(payload))).toBe(true)
    }
  )

  it('Given high RTT When more input queues Then pending bytes share one follow-up send', async () => {
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    let resolveFirstSend: (value: boolean) => void = () => {}
    const sender = async (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      if (payloads.length === 1) {
        return new Promise<boolean>((resolve) => {
          resolveFirstSend = resolve
        })
      }
      return true
    }

    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender)
    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender)
    const third = queueTerminalLiveMirrorSend(state, 'terminal-1', 'c', sender)
    await Promise.resolve()

    expect(payloads).toEqual(['a'])
    resolveFirstSend(true)
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    expect(payloads).toEqual(['a', 'bc'])
  })

  it('batches repeated controls behind an in-flight send, apart from the text before them', async () => {
    const state = createTerminalLivePendingFlushState()
    const writes: string[] = []
    let release = (): void => {}
    const sender = (_handle: string, payload: string): Promise<boolean> => {
      writes.push(payload)
      return writes.length === 1
        ? new Promise<boolean>((resolve) => {
            release = () => resolve(true)
          })
        : Promise.resolve(true)
    }
    const text = queueTerminalLiveMirrorSend(state, 'terminal-1', 'ls', sender)
    void queueTerminalLiveMirrorSend(state, 'terminal-1', ' -la', sender)
    const controls = ['\x1b[A', '\x1b[A', '\r'].map((bytes) =>
      queueTerminalLiveControlSend(state, 'terminal-1', bytes, sender)
    )

    release()

    await expect(text).resolves.toBe(true)
    await expect(Promise.all(controls)).resolves.toEqual([true, true, true])
    expect(writes).toEqual(['ls', ' -la', '\x1b[A\x1b[A\r'])
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    const state = createTerminalLivePendingFlushState()

    await queueTerminalLiveMirrorSend(state, 'terminal-1', 'payload', async () => true)
    await Promise.resolve()

    expect(state.current).toBeNull()
  })

  it('cancels flush waiters before the retired transport acknowledges', async () => {
    const state = createTerminalLivePendingFlushState()
    let releaseRetired = (_sent: boolean): void => {}
    let releaseFresh = (_sent: boolean): void => {}
    const retired = queueTerminalLiveMirrorSend(
      state,
      'retired',
      'old',
      () =>
        new Promise<boolean>((resolve) => {
          releaseRetired = resolve
        })
    )
    let controlResult: boolean | null = null
    const control = waitForTerminalLivePendingFlush(state).then((sent) => {
      controlResult = sent
    })

    cancelTerminalLivePendingFlush(state)
    const fresh = queueTerminalLiveMirrorSend(
      state,
      'fresh',
      'new',
      () =>
        new Promise<boolean>((resolve) => {
          releaseFresh = resolve
        })
    )
    const freshBarrier = waitForTerminalLivePendingFlush(state)
    try {
      await vi.waitFor(() => expect(controlResult).toBe(false))
      await expect(retired).resolves.toBe(false)
      releaseRetired(true)
      await Promise.resolve()
      expect(state.current).toBe(freshBarrier)
      cancelTerminalLivePendingFlush(state)
      await expect(freshBarrier).resolves.toBe(false)
      await expect(fresh).resolves.toBe(false)
    } finally {
      releaseRetired(true)
      releaseFresh(true)
      await control
    }
  })

  it('Given queued input When the queue is cancelled Then unsent input is dropped', async () => {
    const state = createTerminalLivePendingFlushState()
    let resolveSend: (value: boolean) => void = () => {}
    const sender = async (): Promise<boolean> =>
      new Promise((resolve) => {
        resolveSend = resolve
      })
    const active = queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender)
    const pending = queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender)

    cancelTerminalLivePendingFlush(state)

    await expect(Promise.all([active, pending])).resolves.toEqual([false, false])
    expect(state.current).toBeNull()
    resolveSend(true)
  })
})
