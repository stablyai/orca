import { describe, expect, it } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  queueTerminalLivePendingFlush,
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

  it('Given a queued pending flush When it resolves or rejects Then clears the barrier', async () => {
    // Given
    const resolvedState: TerminalLivePendingFlushState = { current: null }
    const rejectedState: TerminalLivePendingFlushState = { current: null }

    // When
    await expect(queueTerminalLivePendingFlush(resolvedState, async () => true)).resolves.toBe(true)
    await expect(
      queueTerminalLivePendingFlush(rejectedState, async () => {
        throw new Error('send failed')
      })
    ).resolves.toBe(false)
    await Promise.resolve()

    // Then
    expect(resolvedState.current).toBeNull()
    expect(rejectedState.current).toBeNull()
  })

  it('Given a current pending snapshot while another flush is in flight When queued Then sends current text after prior success', async () => {
    // Given
    const events: string[] = []
    let resolveFirstFlush: (value: boolean) => void = () => {}
    const firstFlush = new Promise<boolean>((resolve) => {
      resolveFirstFlush = resolve
    })
    const state: TerminalLivePendingFlushState = { current: firstFlush }

    // When
    const secondFlush = queueTerminalLivePendingFlush(state, async () => {
      events.push('second-flush')
      return true
    })
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
    resolveFirstFlush(true)
    await expect(secondFlush).resolves.toBe(true)
    await expect(controlSend).resolves.toBe(true)
    expect(events).toEqual(['second-flush', 'control'])
  })

  it('Given a prior pending flush fails When another snapshot is queued Then skips the current text and control', async () => {
    // Given
    const events: string[] = []
    let resolveFirstFlush: (value: boolean) => void = () => {}
    const firstFlush = new Promise<boolean>((resolve) => {
      resolveFirstFlush = resolve
    })
    const state: TerminalLivePendingFlushState = { current: firstFlush }

    // When
    const secondFlush = queueTerminalLivePendingFlush(state, async () => {
      events.push('second-flush')
      return true
    })
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    resolveFirstFlush(false)

    // Then
    await expect(secondFlush).resolves.toBe(false)
    await expect(controlSend).resolves.toBe(false)
    expect(events).toEqual([])
  })
})
