import { describe, expect, it } from 'vitest'
import { mobileDiffImageDataUri } from './mobile-diff-image-preview'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8sm7wAAAABJRU5ErkJggg=='

describe('mobileDiffImageDataUri', () => {
  it('renders a modified image diff from the post-change bytes', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent: PNG_BASE64,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${PNG_BASE64}`)
  })

  it('renders an added image diff (no original) from the modified bytes', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: PNG_BASE64,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${PNG_BASE64}`)
  })

  it('falls back to the original bytes for a proven deletion (modifiedDeleted)', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: PNG_BASE64,
        originalIsBinary: true,
        modifiedContent: '',
        modifiedIsBinary: false,
        modifiedDeleted: true,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${PNG_BASE64}`)
  })

  // Empty modified bytes can mean a relay/SSH read failure; without proven deletion, original bytes would show a stale image.
  it('returns null on a read failure (empty modified, no modifiedDeleted flag)', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        originalIsBinary: true,
        modifiedContent: '',
        modifiedIsBinary: false,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBeNull()
  })

  // Size-capped modifications also have empty bytes; do not fall back to the stale original.
  it('returns null for a modify whose binary modified side is empty (no stale fallback)', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        originalIsBinary: true,
        modifiedContent: '',
        modifiedIsBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBeNull()
  })

  it('returns null for a non-previewable binary (no isImage/mimeType)', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: 'AAAA'
      })
    ).toBeNull()
  })

  it('returns null when flagged as image but carrying no bytes', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: '',
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBeNull()
  })

  it('returns null for application/pdf even when flagged as previewable', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: 'JVBER',
        isImage: true,
        mimeType: 'application/pdf'
      })
    ).toBeNull()
  })

  it('returns null when flagged as image but mimeType is missing', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: 'bmV3',
        isImage: true
      })
    ).toBeNull()
  })
})
