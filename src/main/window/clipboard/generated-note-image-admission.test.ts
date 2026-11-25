import { expect, it } from 'vitest'
import { isAdmissibleGeneratedNoteImage } from './generated-note-image-admission'

// A whole 2x3 RGBA PNG.
const PNG_2x3 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0,
  0, 185, 234, 222, 129, 0, 0, 0, 27, 73, 68, 65, 84, 120, 156, 99, 96, 208, 8, 168, 88, 112, 226,
  131, 4, 3, 132, 114, 200, 96, 128, 80, 19, 118, 0, 0, 146, 219, 11, 161, 109, 59, 12, 242, 0, 0,
  0, 0, 73, 69, 78, 68, 174, 66, 96, 130
])
// The same header with every CRC valid, but image data for only two of its three rows.
const PNG_2x3_TWO_ROWS = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0,
  0, 185, 234, 222, 129, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 96, 208, 8, 168, 88, 112, 226,
  131, 4, 3, 132, 114, 200, 0, 0, 60, 242, 7, 65, 104, 7, 99, 143, 0, 0, 0, 0, 73, 69, 78, 68, 174,
  66, 96, 130
])

it('admits a notes PNG only when its image data decodes to exactly its rows', () => {
  expect(isAdmissibleGeneratedNoteImage(PNG_2x3)).toBe(true)
  expect(isAdmissibleGeneratedNoteImage(PNG_2x3_TWO_ROWS)).toBe(false)
  expect(isAdmissibleGeneratedNoteImage(PNG_2x3.subarray(0, 60))).toBe(false)
})
