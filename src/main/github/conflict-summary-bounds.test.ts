import { describe, expect, it } from 'vitest'
import {
  parseMergeTreeNameOnlyOutput,
  PR_CONFLICT_FILES_MAX_BYTES,
  PR_CONFLICT_FILES_MAX_ENTRIES
} from './conflict-summary'

describe('PR conflict summary retention bounds', () => {
  it('caps retained conflict file count', () => {
    const stdout = [
      'tree-oid',
      ...Array.from({ length: PR_CONFLICT_FILES_MAX_ENTRIES + 1 }, (_, index) => `file-${index}`)
    ].join('\0')
    const files = parseMergeTreeNameOnlyOutput(stdout)
    expect(files).toHaveLength(PR_CONFLICT_FILES_MAX_ENTRIES)
    expect(files.at(-1)).toBe(`file-${PR_CONFLICT_FILES_MAX_ENTRIES - 1}`)
  })

  it('stops before retaining an oversized path', () => {
    const files = parseMergeTreeNameOnlyOutput(
      `tree-oid\0${'x'.repeat(PR_CONFLICT_FILES_MAX_BYTES + 1)}\0later`
    )
    expect(files).toEqual([])
  })
})
