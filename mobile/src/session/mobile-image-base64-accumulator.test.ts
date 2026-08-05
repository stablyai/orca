import { describe, expect, it } from 'vitest'
import { MobileImageBase64Accumulator } from './mobile-image-base64-accumulator'

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}

describe('MobileImageBase64Accumulator', () => {
  it('preserves bytes split across non-aligned source chunks', () => {
    const accumulator = new MobileImageBase64Accumulator()
    accumulator.append(new Uint8Array([1]))
    accumulator.append(new Uint8Array([2, 3]))
    accumulator.append(new Uint8Array([4, 5]))

    expect(accumulator.finish()).toBe('AQIDBAU=')
  })

  it('preserves bytes across internal staging flushes', () => {
    const bytes = new Uint8Array(256 * 1024 + 7)
    bytes.forEach((_, index) => {
      bytes[index] = index % 251
    })
    const accumulator = new MobileImageBase64Accumulator()
    accumulator.append(bytes.subarray(0, 123_457))
    accumulator.append(bytes.subarray(123_457))

    expect(decodeBase64(accumulator.finish())).toEqual(bytes)
  })
})
