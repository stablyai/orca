import { expect, it } from 'vitest'
import { extendTranscriptBoundary } from './transcript-file-version'

it('owns only the final 64 bytes of a large read', () => {
  const chunk = Buffer.alloc(4 * 1024 * 1024, 'x')
  chunk.write('end', chunk.length - 3)
  const boundary = extendTranscriptBoundary(Buffer.from('previous'), chunk)
  expect(boundary.toString()).toBe(`${'x'.repeat(61)}end`)
  expect(boundary.buffer.byteLength).toBe(64)
  chunk.fill('y')
  expect(boundary.toString()).toBe(`${'x'.repeat(61)}end`)
})
