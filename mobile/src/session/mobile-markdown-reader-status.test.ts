import { describe, expect, it } from 'vitest'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'

const readOnlyDoc = {
  status: 'ready' as const,
  content: '# head',
  localContent: '# head',
  baseVersion: 'v1',
  isDirty: false,
  editable: false,
  readOnlyReason: 'file_too_large'
}

describe('markdownReaderStatusText', () => {
  it('names a truncated preview with or without the full file size', () => {
    expect(
      markdownReaderStatusText({ ...readOnlyDoc, truncated: true, byteLength: 3_000_000 })
    ).toBe('Preview truncated. File size: 2.9 MB.')
    expect(markdownReaderStatusText({ ...readOnlyDoc, truncated: true })).toBe('Preview truncated.')
  })

  it('shows read-only, stale and save-error states, and no status for a clean editable document', () => {
    expect(
      markdownReaderStatusText({ ...readOnlyDoc, editable: true, readOnlyReason: undefined })
    ).toBeNull()
    expect(markdownReaderStatusText(readOnlyDoc)).toBe('Read only')
    expect(
      markdownReaderStatusText({ ...readOnlyDoc, readOnlyReason: undefined, stale: true })
    ).toBe('Changed on desktop')
    expect(
      markdownReaderStatusText({
        ...readOnlyDoc,
        editable: true,
        readOnlyReason: undefined,
        saveError: 'Save failed'
      })
    ).toBe('Save failed')
  })
})
