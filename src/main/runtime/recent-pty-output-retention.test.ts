import { describe, expect, it } from 'vitest'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('recent PTY output retention', () => {
  it.each([true, false])(
    'releases oversized parent strings with boundary preservation=%s',
    (preserveChunkBoundaries) => {
      const count = 8
      const before = heapAfterGc()
      const buffers = Array.from({ length: count }, (_value, index) => {
        const buffer = new RecentPtyOutputBuffer({ preserveChunkBoundaries })
        buffer.append(`${index}:${'x'.repeat(4 * 1024 * 1024)}`)
        return buffer
      })
      const growth = heapAfterGc() - before

      expect(growth).toBeLessThan(count * RECENT_PTY_OUTPUT_LIMIT * 4)
      for (const buffer of buffers) {
        expect(buffer.read()).toBe('x'.repeat(RECENT_PTY_OUTPUT_LIMIT))
        expect(buffer.retainedChunks().headChunkIsPartial).toBe(true)
        buffer.append('next')
        expect(buffer.read()).toBe(`${'x'.repeat(RECENT_PTY_OUTPUT_LIMIT - 4)}next`)
      }
    }
  )
})
