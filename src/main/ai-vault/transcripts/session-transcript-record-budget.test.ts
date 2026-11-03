import { expect, it } from 'vitest'
import { mergeSkippedTranscriptRecords } from './session-transcript-record-budget'

const MiB = 1024 * 1024

it('merges skips by start offset and keeps the larger size', () => {
  expect(
    mergeSkippedTranscriptRecords(
      [{ byteOffset: 40, approximateBytes: 11 * MiB }],
      [
        { byteOffset: 40, approximateBytes: 14 * MiB },
        { byteOffset: 8, approximateBytes: 12 * MiB }
      ]
    )
  ).toEqual([
    { byteOffset: 8, approximateBytes: 12 * MiB },
    { byteOffset: 40, approximateBytes: 14 * MiB }
  ])
})

it('caps the tracked list so a pathological transcript cannot grow it', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    byteOffset: index * 11 * MiB,
    approximateBytes: 11 * MiB
  }))
  expect(mergeSkippedTranscriptRecords([], many)).toHaveLength(32)
})
