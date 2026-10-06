import { describe, expect, it, vi } from 'vitest'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

// Regression for #20802: when the transport discarded a multiplex frame the host closed only the
// multiplex, leaving the client's socket open with nothing behind it, so every later Input frame
// was dropped with no error. The connection must now close so every client build recovers.
describe('terminal multiplex discarded-frame close', () => {
  it('closes the whole connection once when the transport discards a frame', async () => {
    let discard = false
    const closeConnection = vi.fn()
    const harness = startDesktopMultiplexSubscribe(
      {},
      undefined,
      () => (discard ? false : undefined),
      closeConnection
    )
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    discard = true
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(closeConnection).toHaveBeenCalled())
    await harness.dispatchPromise

    expect(closeConnection).toHaveBeenCalledOnce()
    expect(closeConnection).toHaveBeenCalledWith(1013, expect.stringContaining('dropped'))
  })

  it('leaves the connection alone while the transport accepts every frame', async () => {
    const closeConnection = vi.fn()
    const harness = startDesktopMultiplexSubscribe({}, undefined, undefined, closeConnection)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )

    expect(harness.binaryFrames.length).toBeGreaterThan(0)
    expect(closeConnection).not.toHaveBeenCalled()
  })
})
