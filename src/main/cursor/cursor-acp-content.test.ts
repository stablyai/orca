import { describe, expect, it } from 'vitest'
import { cursorAcpMessageContent } from './cursor-acp-content'

describe('Cursor ACP content translation', () => {
  it('keeps text and embedded resource text, without fetching links', () => {
    expect(cursorAcpMessageContent({ type: 'text', text: 'Answer' })).toEqual({ text: 'Answer' })
    expect(
      cursorAcpMessageContent({
        type: 'resource',
        resource: { uri: 'file:///repo/README', text: 'Context' }
      })
    ).toEqual({ text: 'file:///repo/README\nContext' })
    expect(
      cursorAcpMessageContent({ type: 'resource_link', uri: 'file:///repo/image', name: 'Image' })
    ).toEqual({ text: 'Image: file:///repo/image' })
  })
  it('preserves bounded, explicitly unrenderable image replay instead of breaking resume', () => {
    const result = cursorAcpMessageContent({
      type: 'image',
      mimeType: 'image/png',
      data: 'A'.repeat(20000)
    })
    expect(result.block?.providerFrame).toMatchObject({
      provider: 'cursor',
      kind: 'content:image',
      payload: { truncated: true }
    })
    expect(result.text).toBe('Cursor sent content Orca cannot display yet')
    expect(Buffer.byteLength(result.block?.providerFrame?.payload.head ?? '')).toBeLessThanOrEqual(
      16384
    )
  })
  it('refuses invalid or unknown content rather than treating it as prompt evidence', () => {
    expect(() => cursorAcpMessageContent({ type: 'image', data: 'AA==' })).toThrow()
    expect(() => cursorAcpMessageContent({ type: 'future' })).toThrow()
  })
})
