import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()

    // When / Then
    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })

  it('Given an in-flight flush When control input waits Then control is held until flush succeeds', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    await Promise.resolve()

    // Then
    expect(events).toEqual([])
    resolveFlush(true)
    await expect(controlSend).resolves.toBe(true)
    expect(events).toEqual(['control'])
  })

  it('Given an in-flight flush fails When control input waits Then control is skipped', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    resolveFlush(false)

    // Then
    await expect(controlSend).resolves.toBe(false)
    expect(events).toEqual([])
  })
})

describe('terminal live mirror send queue', () => {
  it('Given high RTT When more input queues Then pending bytes share one follow-up send', async () => {
    // Given
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

    // When
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender)
    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender)
    const third = queueTerminalLiveMirrorSend(state, 'terminal-1', 'c', sender)
    await Promise.resolve()

    // Then
    expect(payloads).toEqual(['a'])
    resolveFirstSend(true)
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    expect(payloads).toEqual(['a', 'bc'])
  })

  it('Given a failed previous send When a mirror send queues Then it still runs in order', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const order: string[] = []
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'first', async () => {
      order.push('first')
      return false
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', async () => {
      order.push('second')
      return true
    })

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('Given a throwing send When a mirror send queues Then the promise resolves false and the chain continues', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'first', async () => {
      throw new Error('boom')
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', async () => true)

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()

    // When
    await queueTerminalLiveMirrorSend(state, 'terminal-1', 'payload', async () => true)
    await Promise.resolve()

    // Then
    expect(state.current).toBeNull()
  })

  it('Given queued input When the queue is cancelled Then unsent input is dropped', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    let resolveSend: (value: boolean) => void = () => {}
    const sender = async (): Promise<boolean> =>
      new Promise((resolve) => {
        resolveSend = resolve
      })
    const active = queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender)
    const pending = queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender)

    // When
    cancelTerminalLivePendingFlush(state)

    // Then
    await expect(Promise.all([active, pending])).resolves.toEqual([false, false])
    expect(state.current).toBeNull()
    resolveSend(true)
  })

  it('Given a host that orders sends When keys are typed during a slow round trip Then each leaves at once', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    const acks: ((sent: boolean) => void)[] = []
    const sender = (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      return new Promise<boolean>((resolve) => acks.push(resolve))
    }

    // When
    const keys = ['a', 'b', 'c'].map((key) =>
      queueTerminalLiveMirrorSend(state, 'terminal-1', key, sender, 3)
    )

    // Then
    expect(payloads).toEqual(['a', 'b', 'c'])
    acks.forEach((ack) => ack(true))
    await expect(Promise.all(keys)).resolves.toEqual([true, true, true])
  })

  it('Given a full window When more keys are typed Then they share the send that the next reply releases', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    const acks: ((sent: boolean) => void)[] = []
    const sender = (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      return new Promise<boolean>((resolve) => acks.push(resolve))
    }
    const keys = ['a', 'b', 'c', 'd'].map((key) =>
      queueTerminalLiveMirrorSend(state, 'terminal-1', key, sender, 2)
    )
    expect(payloads).toEqual(['a', 'b'])

    // When
    acks[0](true)
    await keys[0]

    // Then
    expect(payloads).toEqual(['a', 'b', 'cd'])
    acks.slice(1).forEach((ack) => ack(true))
    await Promise.all(keys)
  })

  it('Given a send already out under one-at-a-time When the window opens Then it widens only after that send returns', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    const acks: ((sent: boolean) => void)[] = []
    const sender = (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      return new Promise<boolean>((resolve) => acks.push(resolve))
    }
    const first = queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender, 1)

    // When
    const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender, 4)

    // Then
    expect(payloads).toEqual(['a'])
    acks[0](true)
    await first
    expect(payloads).toEqual(['a', 'b'])
    acks[1](true)
    await second
  })

  it('Given several sends outstanding When control input waits Then it is held until every one has returned', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const acks: ((sent: boolean) => void)[] = []
    const sender = (): Promise<boolean> => new Promise<boolean>((resolve) => acks.push(resolve))
    void queueTerminalLiveMirrorSend(state, 'terminal-1', 'a', sender, 2)
    void queueTerminalLiveMirrorSend(state, 'terminal-1', 'b', sender, 2)
    let released: boolean | null = null
    void waitForTerminalLivePendingFlush(state).then((sent) => {
      released = sent
    })

    // When
    acks[1](true)
    await Promise.resolve()
    await Promise.resolve()

    // Then
    expect(released).toBeNull()
    acks[0](false)
    await vi.waitFor(() => expect(released).toBe(false))
    expect(state.current).toBeNull()
  })
})
