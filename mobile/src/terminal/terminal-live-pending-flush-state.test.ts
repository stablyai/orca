import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  isTerminalLiveInputWithinByteLimit,
  TERMINAL_LIVE_INPUT_MAX_BYTES
} from './terminal-live-input'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    const state = createTerminalLivePendingFlushState()

    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })

  it('Given an in-flight flush When control input waits Then control is held until flush succeeds', async () => {
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    await Promise.resolve()

    expect(events).toEqual([])
    resolveFlush(true)
    await expect(controlSend).resolves.toBe(true)
    expect(events).toEqual(['control'])
  })

  it('Given an in-flight flush fails When control input waits Then control is skipped', async () => {
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    resolveFlush(false)

    await expect(controlSend).resolves.toBe(false)
    expect(events).toEqual([])
  })
})

describe('terminal live mirror send queue', () => {
  it('settles queued input when the sender throws before returning a promise', async () => {
    const state = createTerminalLivePendingFlushState()
    const writes: string[] = []
    const results: Array<boolean | null> = [null, null]
    const sender = (_handle: string, payload: string): Promise<boolean> => {
      writes.push(payload)
      if (writes.length === 1) {
        throw new Error('transport unavailable')
      }
      return Promise.resolve(true)
    }
    void queueTerminalLiveMirrorSend(state, 'terminal-1', 'first', sender).then((sent) => {
      results[0] = sent
    })
    void queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', sender).then((sent) => {
      results[1] = sent
    })

    await waitForTerminalLivePendingFlush(state)

    expect(results).toEqual([false, true])
    expect(writes).toEqual(['first', 'second'])
    expect(state.activeRequests).toEqual([])
    expect(state.pendingBatches).toEqual([])
    await expect(queueTerminalLiveMirrorSend(state, 'terminal-1', 'fresh', sender)).resolves.toBe(
      true
    )
  })

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

  it('Given a failed previous send When a mirror send queues Then it still runs in order', async () => {
    const state = createTerminalLivePendingFlushState()
    const order: string[] = []
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'first', async () => {
      order.push('first')
      return false
    })

    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', async () => {
      order.push('second')
      return true
    })

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('Given a throwing send When a mirror send queues Then the promise resolves false and the chain continues', async () => {
    const state = createTerminalLivePendingFlushState()
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'first', async () => {
      throw new Error('boom')
    })

    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', async () => true)

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
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
    const controlBytes: string[] = []
    let controlResult: boolean | null = null
    const control = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        controlBytes.push('enter')
        return true
      }
    ).then((sent) => {
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
      expect(controlBytes).toEqual([])
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
