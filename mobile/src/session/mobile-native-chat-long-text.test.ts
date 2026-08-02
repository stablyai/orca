import { describe, expect, it } from 'vitest'
import {
  MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS,
  splitMobileNativeChatLongText
} from './mobile-native-chat-long-text'

describe('splitMobileNativeChatLongText', () => {
  it('bounds render nodes while preserving the exact full text', () => {
    const text = Array.from(
      { length: 1800 },
      (_, index) => `Paragraph ${index}: readable prose.`
    ).join('\n\n')
    const chunks = splitMobileNativeChatLongText(text)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.text.length <= MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS)).toBe(
      true
    )
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(new Set(chunks.map((chunk) => chunk.start)).size).toBe(chunks.length)
    expect(splitMobileNativeChatLongText(text).map((chunk) => chunk.start)).toEqual(
      chunks.map((chunk) => chunk.start)
    )
  })

  it('does not split surrogate pairs at a hard boundary', () => {
    const text = `${'a'.repeat(MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS - 1)}😀tail`
    const chunks = splitMobileNativeChatLongText(text)

    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(chunks[0]?.text.endsWith('\ud83d')).toBe(false)
    expect(chunks[1]?.text.startsWith('\ude00')).toBe(false)
  })
})
