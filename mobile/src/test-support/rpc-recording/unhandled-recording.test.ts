import { describe, expect, it } from 'vitest'
import { recordUnhandledRejections } from './unhandled-recording'

// No golden records an unhandled rejection any more, so this is the only thing pinning the capture.
describe('recordUnhandledRejections', () => {
  it('records a detached rejection as an effect and restores the prior listeners', async () => {
    const before = process.rawListeners('unhandledRejection')
    const effects: { name: string; value: unknown }[] = []

    const stop = recordUnhandledRejections((name, value) => effects.push({ name, value }))
    void Promise.reject(new TypeError("Cannot read properties of null (reading 'ui')"))
    await new Promise((resolve) => setImmediate(resolve))
    stop()

    expect(effects).toEqual([
      {
        name: 'unhandled-rejection',
        value: {
          category: 'TypeError',
          message: "Cannot read properties of null (reading 'ui')",
          isRpcDeliveryUnknown: false
        }
      }
    ])
    expect(process.rawListeners('unhandledRejection')).toEqual(before)
  })
})
