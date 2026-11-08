import { expect, it } from 'vitest'
import { frameOver } from '../src/bytes'

it('measures frames in UTF-8 bytes, as ws maxPayload does', () => {
  expect(frameOver('a'.repeat(10), 10)).toBe(false)
  expect(frameOver('a'.repeat(11), 10)).toBe(true)
  // 4 × 3-byte characters = 12 bytes.
  expect(frameOver('€€€€', 10)).toBe(true)
  expect(frameOver('€€€', 10)).toBe(false)
  expect(frameOver(new ArrayBuffer(11), 10)).toBe(true)
  expect(frameOver(new ArrayBuffer(10), 10)).toBe(false)
})
