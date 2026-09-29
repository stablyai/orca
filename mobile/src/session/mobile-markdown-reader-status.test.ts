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
  it('names a truncated preview and the full file size the way file tabs do', () => {
    expect(
      markdownReaderStatusText({ ...readOnlyDoc, truncated: true, byteLength: 3_000_000 })
    ).toBe('Preview truncated. File size: 2.9 MB.')
  })

  it('keeps read-only, stale, and save-error states as before', () => {
    expect(markdownReaderStatusText(readOnlyDoc)).toBe('Read only')
    expect(
      markdownReaderStatusText({ ...readOnlyDoc, readOnlyReason: undefined, stale: true })
    ).toBe('Changed on desktop')
    expect(markdownReaderStatusText({ ...readOnlyDoc, saveError: 'Save failed' })).toBe(
      'Save failed'
    )
  })
})
