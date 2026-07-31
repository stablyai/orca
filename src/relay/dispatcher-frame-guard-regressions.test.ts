import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import type { JsonRpcNotification } from './protocol'

type DispatcherInternals = {
  primaryClient: object
  estimateFrameBytes: (msg: JsonRpcNotification) => number
  enqueueFrame: (client: object, msg: JsonRpcNotification, lane: string) => boolean
}

describe('RelayDispatcher frame guards', () => {
  it('returns zero for invalid active-client limits without encoding', () => {
    const dispatcher = new RelayDispatcher(() => true, {
      writableHighWaterMark: () => 1024 * 1024,
      writableLength: () => 0
    })
    try {
      const spy = vi.spyOn(dispatcher as unknown as DispatcherInternals, 'estimateFrameBytes')
      for (const limit of [0, -1, Number.NaN]) {
        expect(dispatcher.maxLegacyPtyDataChars({ id: 'pty-1' }, 'hello', limit)).toBe(0)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not estimate frames after disposal', () => {
    const dispatcher = new RelayDispatcher(() => true)
    const internals = dispatcher as unknown as DispatcherInternals
    const spy = vi.spyOn(internals, 'estimateFrameBytes')
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'pty.data',
      params: {
        data: {
          toJSON: () => {
            throw new Error('must not serialize')
          }
        }
      }
    }
    dispatcher.dispose()
    expect(internals.enqueueFrame(internals.primaryClient, msg, 'ordinary')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
