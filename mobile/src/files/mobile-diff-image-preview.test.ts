import { describe, expect, it } from 'vitest'
import { mobileDiffImageDataUri } from './mobile-diff-image-preview'

function pngBase64(width = 1): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes.toString('base64')
}

describe('mobileDiffImageDataUri', () => {
  it('renders a modified image diff from the post-change bytes', () => {
    const modifiedContent = pngBase64(2)
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${modifiedContent}`)
  })

  it('renders an added image diff (no original) from the modified bytes', () => {
    const modifiedContent = pngBase64()
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent: '',
        modifiedContent,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${modifiedContent}`)
  })

  it('falls back to the original bytes for a proven deletion (modifiedDeleted)', () => {
    const originalContent = pngBase64()
    expect(
      mobileDiffImageDataUri({
        kind: 'binary',
        originalContent,
        originalIsBinary: true,
        modifiedContent: '',
        modifiedIsBinary: false,
        modifiedDeleted: true,
        isImage: true,
        mimeType: 'image/png'
      })
    ).toBe(`data:image/png;base64,${originalContent}`)
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
