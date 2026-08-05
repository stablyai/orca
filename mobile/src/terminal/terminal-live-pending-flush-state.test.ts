import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'
import {
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
  it('Given a failed previous send When a mirror send queues Then it still runs in order', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const order: string[] = []
    const results = [false, true]
    const send = async (payload: string): Promise<boolean> => {
      order.push(payload)
      return results.shift() ?? false
    }
    const first = queueTerminalLiveMirrorSend(state, 'terminal-a', 'first', send)

    // When
    const second = queueTerminalLiveMirrorSend(state, 'terminal-a', 'second', send)

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('Given a throwing send When a mirror send queues Then the promise resolves false and the chain continues', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    let callCount = 0
    const send = async (): Promise<boolean> => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('boom')
      }
      return true
    }
    const first = queueTerminalLiveMirrorSend(state, 'terminal-a', 'first', send)

    // When
    const second = queueTerminalLiveMirrorSend(state, 'terminal-a', 'second', send)

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()

    // When
    await queueTerminalLiveMirrorSend(state, 'terminal-a', 'first', async () => true)
    await Promise.resolve()

    // Then
    expect(state.current).toBeNull()
  })

  it('Given Relay-delayed typing When one RPC is in flight Then coalesces the queued deltas', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    const resolvers: Array<(accepted: boolean) => void> = []
    const send = (payload: string): Promise<boolean> => {
      payloads.push(payload)
      return new Promise((resolve) => resolvers.push(resolve))
    }

    // When
    const first = queueTerminalLiveMirrorSend(state, 'terminal-a', 'a', send)
    const second = queueTerminalLiveMirrorSend(state, 'terminal-a', 'b', send)
    const third = queueTerminalLiveMirrorSend(state, 'terminal-a', 'c', send)

    // Then: one immediate RPC, then one catch-up RPC instead of three RTTs.
    expect(payloads).toEqual(['a'])
    resolvers.shift()?.(true)
    await expect(first).resolves.toBe(true)
    await vi.waitFor(() => expect(payloads).toEqual(['a', 'bc']))
    resolvers.shift()?.(true)
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    await Promise.resolve()
    expect(state.current).toBeNull()
  })

  it('Given a terminal switch during Relay delay When queued sends drain Then keeps handles separate', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    const resolvers: Array<(accepted: boolean) => void> = []
    const send =
      (handle: string) =>
      (payload: string): Promise<boolean> => {
        payloads.push(`${handle}:${payload}`)
        return new Promise((resolve) => resolvers.push(resolve))
      }

    // When
    const first = queueTerminalLiveMirrorSend(state, 'terminal-a', 'a', send('terminal-a'))
    const second = queueTerminalLiveMirrorSend(state, 'terminal-b', 'b', send('terminal-b'))
    const third = queueTerminalLiveMirrorSend(state, 'terminal-b', 'c', send('terminal-b'))

    // Then
    expect(payloads).toEqual(['terminal-a:a'])
    resolvers.shift()?.(true)
    await expect(first).resolves.toBe(true)
    await vi.waitFor(() => expect(payloads).toEqual(['terminal-a:a', 'terminal-b:bc']))
    resolvers.shift()?.(true)
    await expect(Promise.all([second, third])).resolves.toEqual([true, true])
  })

  it('Given queued input at the RPC byte limit When batching Then keeps the next delta separate', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloadSizes: number[] = []
    const resolvers: Array<(accepted: boolean) => void> = []
    const send = (payload: string): Promise<boolean> => {
      payloadSizes.push(payload.length)
      return new Promise((resolve) => resolvers.push(resolve))
    }

    // When
    const first = queueTerminalLiveMirrorSend(state, 'terminal-a', 'x', send)
    const atLimit = queueTerminalLiveMirrorSend(
      state,
      'terminal-a',
      'x'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES),
      send
    )
    const afterLimit = queueTerminalLiveMirrorSend(state, 'terminal-a', 'y', send)

    // Then
    resolvers.shift()?.(true)
    await expect(first).resolves.toBe(true)
    await vi.waitFor(() => expect(payloadSizes).toEqual([1, TERMINAL_LIVE_INPUT_MAX_BYTES]))
    resolvers.shift()?.(true)
    await vi.waitFor(() => expect(payloadSizes).toEqual([1, TERMINAL_LIVE_INPUT_MAX_BYTES, 1]))
    resolvers.shift()?.(true)
    await expect(Promise.all([atLimit, afterLimit])).resolves.toEqual([true, true])
  })
})
