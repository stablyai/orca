import { describe, expect, it } from 'vitest'
import {
  createBinaryStreamFrameReader,
  encodeBinaryStreamEventFrame
} from './daemon-stream-binary-framing'

function collectBuffers(): number {
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().arrayBuffers
}

describe('binary daemon stream retained buffers', () => {
  it.each([2, 15])('releases consumed frames while keeping a %i-byte incomplete frame', (split) => {
    const readers: { finish: () => void; count: () => number }[] = []
    const baseline = collectBuffers()
    for (let index = 0; index < 32; index += 1) {
      let count = 0
      const reader = createBinaryStreamFrameReader(
        () => count++,
        (error) => {
          throw error
        }
      )
      const next = encodeBinaryStreamEventFrame({ type: 'event', event: 'next' })
      reader.feed(
        Buffer.concat([
          encodeBinaryStreamEventFrame({
            type: 'event',
            event: 'large',
            payload: 'x'.repeat(1024 * 1024)
          }),
          next.subarray(0, split)
        ])
      )
      readers.push({
        finish: () => reader.feed(next.subarray(split)),
        count: () => count
      })
    }
    const retainedBytes = collectBuffers() - baseline
    expect(readers).toHaveLength(32)
    expect(retainedBytes).toBeLessThan(8 * 1024 * 1024)
    for (const reader of readers) {
      expect(reader.count()).toBe(1)
      reader.finish()
      expect(reader.count()).toBe(2)
    }
  })
})
