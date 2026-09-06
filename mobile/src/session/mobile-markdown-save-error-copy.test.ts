import { describe, expect, it } from 'vitest'
import { mobileMarkdownSaveErrorCopy } from './mobile-markdown-save-error-copy'

describe('mobile markdown save error copy', () => {
  it('explains conflicts without exposing an internal error code', () => {
    expect(mobileMarkdownSaveErrorCopy(new Error('conflict'))).toBe('Changed on desktop')
  })

  it('keeps other failures actionable without exposing host details', () => {
    expect(mobileMarkdownSaveErrorCopy(new Error('not_connected'))).toBe('Desktop is offline')
    expect(mobileMarkdownSaveErrorCopy(new Error('unexpected host detail'))).toBe('Save failed')
  })
})
