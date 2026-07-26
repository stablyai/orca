import { describe, expect, it } from 'vitest'
import { MobileImageBase64Accumulator } from './mobile-image-base64-accumulator'

describe('MobileImageBase64Accumulator', () => {
  it('preserves bytes delivered as 100,000 one-byte fragments', () => {
    const accumulator = new MobileImageBase64Accumulator()
    const expected = Buffer.alloc(100_000)

    for (let index = 0; index < expected.byteLength; index += 1) {
      const value = index % 251
      expected[index] = value
      accumulator.append(Uint8Array.of(value))
    }

    expect(accumulator.finish()).toBe(expected.toString('base64'))
  })
})
