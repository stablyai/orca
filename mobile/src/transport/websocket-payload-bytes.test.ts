import { describe, expect, it, vi } from 'vitest'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

describe('websocketPayloadToUint8', () => {
  it('returns null when a blob-like payload rejects arrayBuffer conversion', async () => {
    await expect(
      websocketPayloadToUint8({
        size: 0,
        arrayBuffer: async () => {
          throw new Error('conversion failed')
        }
      })
    ).resolves.toBeNull()
  })

  it('rejects a declared oversized payload before starting binary conversion', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1))

    await expect(websocketPayloadToUint8({ size: 5, arrayBuffer }, 4)).rejects.toThrow(
      'exceeds inbound frame limit'
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('accepts an exact declared size and verifies the converted result', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(4))

    await expect(websocketPayloadToUint8({ size: 4, arrayBuffer }, 4)).resolves.toEqual(
      new Uint8Array(4)
    )
    expect(arrayBuffer).toHaveBeenCalledOnce()
  })

  it('rejects an unknown-size payload before starting binary conversion', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(4))

    await expect(websocketPayloadToUint8({ arrayBuffer }, 4)).rejects.toThrow(
      'exceeds inbound frame limit'
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'rejects invalid declared size %s before starting binary conversion',
    async (size) => {
      const arrayBuffer = vi.fn(async () => new ArrayBuffer(4))

      await expect(websocketPayloadToUint8({ size, arrayBuffer }, 4)).rejects.toThrow(
        'exceeds inbound frame limit'
      )
      expect(arrayBuffer).not.toHaveBeenCalled()
    }
  )

  it('preserves direct Uint8Array and ArrayBuffer conversion', async () => {
    const uint8 = new Uint8Array([1, 2, 3])
    const arrayBuffer = Uint8Array.from([4, 5, 6]).buffer

    await expect(websocketPayloadToUint8(uint8, 3)).resolves.toBe(uint8)
    await expect(websocketPayloadToUint8(arrayBuffer, 3)).resolves.toEqual(
      new Uint8Array([4, 5, 6])
    )
  })
})
