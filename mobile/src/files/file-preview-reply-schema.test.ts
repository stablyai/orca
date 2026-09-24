import { describe, expect, it } from 'vitest'
import {
  filePreviewImageSchema,
  filePreviewTextSchema,
  terminalPathResolutionSchema
} from './file-preview-reply-schema'

describe('file preview reply schemas', () => {
  it('requires the content the markdown disk fallback publishes unguarded', () => {
    // `content` alone, with no sibling requirement able to stand in for it.
    expect(filePreviewTextSchema.safeParse({ truncated: false, byteLength: 0 }).success).toBe(false)
    expect(filePreviewTextSchema.safeParse({ content: '# readme' }).success).toBe(true)
    expect(filePreviewTextSchema.safeParse({ content: 7 }).success).toBe(false)
  })

  it('salvages truncated and byteLength onto the fallbacks main already had', () => {
    const parsed = filePreviewTextSchema.parse({
      content: 'body',
      truncated: 'yes',
      byteLength: 'four'
    })
    // Absent reads as not truncated, and an unreadable byteLength falls through to content.length
    // at the call site, which is what main's `typeof === 'number'` guard already did.
    expect(parsed.truncated).toBeUndefined()
    expect(parsed.byteLength).toBeUndefined()
  })

  it('keeps every member of an image preview optional so the host binary arms still render', () => {
    // The host answers this shape for a binary it cannot preview, and this one for a path mobile
    // classified as an image and the host did not. Both reach the screen as main's own copy.
    expect(filePreviewImageSchema.safeParse({ content: '', isBinary: true }).success).toBe(true)
    expect(filePreviewImageSchema.safeParse({ content: 'text', isBinary: false }).success).toBe(
      true
    )
  })

  it('salvages an image preview member to the arm main fell back to', () => {
    const parsed = filePreviewImageSchema.parse({
      content: 'aGk=',
      isImage: 'yes',
      mimeType: 7
    })
    expect(parsed.isImage).toBeUndefined()
    expect(parsed.mimeType).toBeUndefined()
  })

  it('refuses a preview payload that is not an object', () => {
    expect(filePreviewTextSchema.safeParse('# readme').success).toBe(false)
    expect(filePreviewImageSchema.safeParse(null).success).toBe(false)
  })

  it('keeps a terminal path resolution readable with every member salvaged', () => {
    const parsed = terminalPathResolutionSchema.parse({
      exists: 'yes',
      isDirectory: false,
      openTarget: { kind: 'absolute-file', absolutePath: '/logs/run.txt', grantId: 'g2' }
    })
    expect(parsed.exists).toBeUndefined()
    expect(parsed.openTarget?.grantId).toBe('g2')
  })

  it('passes a newer host member through on every preview schema', () => {
    expect(filePreviewTextSchema.parse({ content: 'a', encoding: 'utf8' })).toMatchObject({
      encoding: 'utf8'
    })
    expect(
      filePreviewImageSchema.parse({ content: 'a', imageDimensions: { width: 1 } })
    ).toMatchObject({ imageDimensions: { width: 1 } })
  })
})
