import { describe, expect, it } from 'vitest'
import {
  fileTabBinaryDiffSchema,
  fileTabImageSchema,
  fileTabTextDiffSchema,
  fileTabTextSchema
} from './file-tab-doc-reply-schema'

describe('file tab doc reply schemas', () => {
  it('requires the three members the tab publishes into a ready document', () => {
    const ready = { content: 'a', truncated: false, byteLength: 1 }
    expect(fileTabTextSchema.safeParse(ready).success).toBe(true)
    // One at a time, so a sibling requirement cannot stand in for the member under test.
    for (const member of ['content', 'truncated', 'byteLength'] as const) {
      const { [member]: _dropped, ...without } = ready
      expect(fileTabTextSchema.safeParse(without).success).toBe(false)
    }
  })

  it('requires the image content buildImageDataUri calls replace on', () => {
    expect(fileTabImageSchema.safeParse({ isImage: true, mimeType: 'image/png' }).success).toBe(
      false
    )
  })

  it('keeps an image tab readable for the truthy non-boolean isImage main rendered', () => {
    expect(fileTabImageSchema.parse({ content: 'aGk=', isImage: 1 }).isImage).toBe(1)
  })

  it('refuses a wrong-typed mimeType rather than salvaging it', () => {
    // Main threw on `mimeType?.startsWith`, and readFileTab's catch showed
    // "Couldn't load file preview"; salvaging to absent would have shown the binary copy instead.
    expect(fileTabImageSchema.safeParse({ content: 'aGk=', mimeType: 7 }).success).toBe(false)
  })

  it('reads a text diff only when both sides are strings', () => {
    expect(
      fileTabTextDiffSchema.safeParse({ kind: 'text', originalContent: 'a', modifiedContent: 'b' })
        .success
    ).toBe(true)
    expect(fileTabTextDiffSchema.safeParse({ kind: 'text', originalContent: 'a' }).success).toBe(
      false
    )
  })

  it('routes an unknown diff arm to the binary reader and never the text one', () => {
    expect(fileTabBinaryDiffSchema.parse({ kind: 'submodule' }).kind).toBe('binary')
    expect(fileTabBinaryDiffSchema.parse({ kind: 'binary' }).kind).toBe('binary')
    // A text diff whose contents did not arrive must not be re-read as binary: the tab would name
    // the file unpreviewable instead of naming the reply.
    expect(fileTabBinaryDiffSchema.safeParse({ kind: 'text' }).success).toBe(false)
  })

  it('salvages the binary arm members main compared against true', () => {
    const parsed = fileTabBinaryDiffSchema.parse({
      kind: 'binary',
      isImage: 'yes',
      modifiedDeleted: 1,
      modifiedContent: 5
    })
    expect(parsed.isImage).toBeUndefined()
    expect(parsed.modifiedDeleted).toBeUndefined()
    expect(parsed.modifiedContent).toBeUndefined()
  })

  it('passes a newer host member through', () => {
    expect(
      fileTabTextDiffSchema.parse({
        kind: 'text',
        originalContent: 'a',
        modifiedContent: 'b',
        largeDiffRenderLimit: { lines: 10 }
      })
    ).toMatchObject({ largeDiffRenderLimit: { lines: 10 } })
  })
})
