import { expect, it } from 'vitest'
import {
  MAX_SESSION_TRANSCRIPT_RECORD_BYTES,
  describeSkippedTranscriptRecords,
  mergeSkippedTranscriptRecords
} from './session-transcript-record-budget'

const MiB = 1024 * 1024

it('merges skips by start offset and keeps the larger size', () => {
  // The same unterminated record, re-skipped at the same offset once its
  // newline arrives: one entry, grown — not two.
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

it('describes nothing when nothing was skipped', () => {
  expect(describeSkippedTranscriptRecords([])).toBeNull()
})

it('names the limit, the count and the first few sizes', () => {
  expect(
    describeSkippedTranscriptRecords([
      { byteOffset: 0, approximateBytes: MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1 }
    ])
  ).toBe(
    'Skipped 1 oversized transcript record over the 10.0 MiB limit (10.0 MiB at byte 0). The rest of the session was read.'
  )
  const four = Array.from({ length: 4 }, (_, index) => ({
    byteOffset: index * 100,
    approximateBytes: 12 * MiB
  }))
  expect(describeSkippedTranscriptRecords(four)).toBe(
    'Skipped 4 oversized transcript records over the 10.0 MiB limit (12.0 MiB at byte 0, 12.0 MiB at byte 100, 12.0 MiB at byte 200, 1 more). The rest of the session was read.'
  )
})
