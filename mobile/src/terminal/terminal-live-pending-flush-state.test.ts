import { describe, expect, it } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush,
  type TerminalLivePendingFlushState
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }

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
    const state: TerminalLivePendingFlushState = { current: flushPromise }

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
    const state: TerminalLivePendingFlushState = { current: flushPromise }

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
    const state: TerminalLivePendingFlushState = { current: null }
    const order: string[] = []
    const first = queueTerminalLiveMirrorSend(state, async () => {
      order.push('first')
      return false
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, async () => {
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
    const state: TerminalLivePendingFlushState = { current: null }
    const first = queueTerminalLiveMirrorSend(state, async () => {
      throw new Error('boom')
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, async () => true)

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }

    // When
    await queueTerminalLiveMirrorSend(state, async () => true)
    await Promise.resolve()

    // Then
    expect(state.current).toBeNull()
  })
})
