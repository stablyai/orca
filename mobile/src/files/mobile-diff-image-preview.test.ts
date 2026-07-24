import { describe, expect, it } from 'vitest'
import { mobileDiffImageDataUri } from './mobile-diff-image-preview'

describe('mobileDiffImageDataUri', () => {
  it('renders a modified image diff from the post-change bytes', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent: 'bmV3',
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe('data:image/png;base64,bmV3')
  })

  it('renders an added image diff (no original) from the modified bytes', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent: 'bmV3',
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe('data:image/png;base64,bmV3')
  })

  it('falls back to the original bytes for a proven deletion (modifiedDeleted)', () => {
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        originalIsBinary: true,
        modifiedContent: '',
        modifiedIsBinary: false,
        modifiedDeleted: true,
        isImage: true,
        mimeType: 'image/jpeg'
      })
    ).toBe('data:image/jpeg;base64,b2xk')
  })

  // The reviewer's read-failure case: a relay/SSH read returns an empty modified
  // side with modifiedIsBinary false and no modifiedDeleted flag. Without a proven
  // deletion, falling back to the original would show a stale pre-change image, so
  // "unavailable" (null) is the honest result.
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

  // Guards the >size-cap case: the modified side IS a binary image but its bytes
  // arrive empty. Falling back to the original would render the stale pre-change
  // image; "unavailable" is the honest result.
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
