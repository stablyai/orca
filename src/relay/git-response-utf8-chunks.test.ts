import { describe, expect, it } from 'vitest'
import { encodeUtf8StringChunk, planUtf8StringChunks } from './git-response-utf8-chunks'

describe('Git response UTF-8 chunk planning', () => {
  it('round-trips mixed-width text without splitting code points', () => {
    const value = 'ascii-é-€-🐋-end'.repeat(20)
    const plan = planUtf8StringChunks(value, 17)
    const encoded = plan.map((chunk) => encodeUtf8StringChunk(value, chunk))

    expect(Buffer.concat(encoded)).toEqual(Buffer.from(value, 'utf8'))
    expect(plan.every((chunk) => chunk.byteLength <= 17)).toBe(true)
    expect(plan.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      Buffer.byteLength(value, 'utf8')
    )
  })

  it('matches Node replacement encoding for unmatched surrogate code units', () => {
    const value = 'before-\ud800-after-\udc00'
    const plan = planUtf8StringChunks(value, 8)

    expect(Buffer.concat(plan.map((chunk) => encodeUtf8StringChunk(value, chunk)))).toEqual(
      Buffer.from(value, 'utf8')
    )
  })

  it('returns no chunks for empty text and rejects unsafe chunk sizes', () => {
    expect(planUtf8StringChunks('', 4)).toEqual([])
    expect(() => planUtf8StringChunks('value', 3)).toThrow(RangeError)
  })
})
