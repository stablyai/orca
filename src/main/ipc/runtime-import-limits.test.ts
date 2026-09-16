import { describe, expect, it } from 'vitest'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from './runtime-import-limits'

describe('formatByteCeiling', () => {
  it('renders a size one byte over a ceiling as larger than the ceiling', () => {
    // "is 2 GB, over the 2 GB limit" reads like a broken check, not a big file.
    expect(formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES)).toBe('2 GB')
    expect(formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES + 1)).toBe('2.1 GB')
  })

  it('leaves an exact ceiling as a whole number', () => {
    expect(formatByteCeiling(REMOTE_IMPORT_MAX_TOTAL_BYTES)).toBe('8 GB')
    expect(formatByteCeiling(1024)).toBe('1 KB')
  })

  it('scales through the units', () => {
    expect(formatByteCeiling(512)).toBe('512 B')
    expect(formatByteCeiling(1024 * 1024)).toBe('1 MB')
    expect(formatByteCeiling(1024 ** 4)).toBe('1 TB')
  })

  it('rounds up rather than to nearest', () => {
    expect(formatByteCeiling(1024 * 1024 + 1)).toBe('1.1 MB')
  })

  it('does not crash on zero', () => {
    expect(formatByteCeiling(0)).toBe('0 B')
  })
})
