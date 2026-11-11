import { describe, expect, it } from 'vitest'
import { nativeChatTextWithFileReferences } from './mobile-native-chat-file-attachment'

describe('nativeChatTextWithFileReferences', () => {
  it('references each stored file on a line after the text', () => {
    expect(
      nativeChatTextWithFileReferences('Review these  ', [
        { path: '/store/1/spec.pdf' },
        { path: '/store/2/my notes.md' }
      ])
    ).toBe('Review these\n@/store/1/spec.pdf @"/store/2/my notes.md"')
  })

  it('sends the references alone when there is no text, and the text alone with no files', () => {
    expect(nativeChatTextWithFileReferences('  ', [{ path: '/store/1/spec.pdf' }])).toBe(
      '@/store/1/spec.pdf'
    )
    expect(nativeChatTextWithFileReferences('hi', [])).toBe('hi')
  })
})
