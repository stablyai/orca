import { describe, expect, it } from 'vitest'
import { createRootIndex, recordIndexedFile, wouldExceedCap } from './device-store-eviction'

function exactIndex(files: Record<string, number>) {
  const index = createRootIndex()
  for (const [uri, size] of Object.entries(files)) {
    recordIndexedFile(index, uri, size, 0)
  }
  index.exact = true
  return index
}

describe('the draft cap check', () => {
  it('applies a key changed twice in one write once, as the write leaves it', () => {
    // On disk: a and d at 8 KiB each. Deleting a twice frees 8 KiB, not 16, so two new 8 KiB rows cross 20 KiB.
    expect(
      wouldExceedCap(exactIndex({ a: 8192, d: 8192 }), 20_480, [
        { uri: 'a', size: null },
        { uri: 'a', size: null },
        { uri: 'b', size: 8192 },
        { uri: 'c', size: 8192 }
      ])
    ).toBe(true)
    // a ends at 4 KiB, so the write fits an 8 KiB cap although it passes through 12 KiB.
    expect(
      wouldExceedCap(exactIndex({ a: 4096 }), 8192, [
        { uri: 'a', size: 12_288 },
        { uri: 'a', size: 4096 }
      ])
    ).toBe(false)
  })
})
