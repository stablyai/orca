import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'

describe('terminal live control send order', () => {
  it('Given a failed pending text flush When control bytes follow Then skips the control bytes', async () => {
    // Given
    const events: string[] = []
    const flushPendingText = vi.fn(async () => {
      events.push('flush')
      return false
    })
    const sendControlBytes = vi.fn(async () => {
      events.push('control')
      return true
    })

    // When
    const result = await sendTerminalLiveControlAfterPendingFlush(
      flushPendingText,
      sendControlBytes
    )

    // Then
    expect(result).toBe(false)
    expect(sendControlBytes).not.toHaveBeenCalled()
    expect(events).toEqual(['flush'])
  })

  it('Given a successful pending text flush When control bytes follow Then sends them afterward', async () => {
    // Given
    const events: string[] = []
    const flushPendingText = vi.fn(async () => {
      events.push('flush')
      return true
    })
    const sendControlBytes = vi.fn(async () => {
      events.push('control')
      return true
    })

    // When
    const result = await sendTerminalLiveControlAfterPendingFlush(
      flushPendingText,
      sendControlBytes
    )

    // Then
    expect(result).toBe(true)
    expect(events).toEqual(['flush', 'control'])
  })

  it('Given a failed control byte send When pending text flushed Then reports failure', async () => {
    // Given
    const events: string[] = []
    const flushPendingText = vi.fn(async () => {
      events.push('flush')
      return true
    })
    const sendControlBytes = vi.fn(async () => {
      events.push('control')
      return false
    })

    // When
    const result = await sendTerminalLiveControlAfterPendingFlush(
      flushPendingText,
      sendControlBytes
    )

    // Then
    expect(result).toBe(false)
    expect(events).toEqual(['flush', 'control'])
  })
})
