import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

const EXIT_WAIT = {
  handle: 'terminal-1',
  condition: 'exit',
  satisfied: true,
  status: 'exited',
  exitCode: 42
} satisfies RuntimeTerminalWait

function results(messages: readonly string[]): Record<string, unknown>[] {
  return messages.map((message) => JSON.parse(message).result as Record<string, unknown>)
}

describe('terminal multiplex exit capability', () => {
  it('does not emit exited to a legacy subscriber', async () => {
    const harness = startDesktopMultiplexSubscribe({
      waitForTerminal: vi.fn().mockResolvedValue(EXIT_WAIT)
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )

    sendDesktopMultiplexSubscribe(harness.handlers)

    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'end')).toBe(
        true
      )
    )
    expect(results(harness.messages).some((event) => event.type === 'exited')).toBe(false)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('echoes terminalExited and emits exited before end when negotiated', async () => {
    const harness = startDesktopMultiplexSubscribe({
      waitForTerminal: vi.fn().mockResolvedValue(EXIT_WAIT)
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )

    sendDesktopMultiplexSubscribe(harness.handlers, {
      ackOutput: 1,
      desktopViewportClaims: 1,
      terminalExited: 1
    })

    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'end')).toBe(
        true
      )
    )
    const events = results(harness.messages)
    expect(events.find((event) => event.type === 'subscribed')).toMatchObject({
      capabilities: { terminalExited: 1 }
    })
    const exitedIndex = events.findIndex((event) => event.type === 'exited' && event.streamId === 7)
    const endIndex = events.findIndex((event) => event.type === 'end' && event.streamId === 7)
    expect(events[exitedIndex]).toMatchObject({
      type: 'exited',
      streamId: 7,
      exitCode: 42
    })
    expect(endIndex).toBeGreaterThan(exitedIndex)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('never emits exited when the terminal handle is stale', async () => {
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn(() => {
        throw new Error('terminal_handle_stale')
      })
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )

    sendDesktopMultiplexSubscribe(harness.handlers, { terminalExited: 1 })

    await vi.waitFor(() =>
      expect(
        harness.messages.some(
          (message) =>
            JSON.parse(message).result?.type === 'end' && JSON.parse(message).result?.streamId === 7
        )
      ).toBe(true)
    )
    const events = results(harness.messages)
    expect(events.some((event) => event.type === 'exited')).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        streamId: 7,
        message: 'terminal_handle_stale'
      })
    )
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
