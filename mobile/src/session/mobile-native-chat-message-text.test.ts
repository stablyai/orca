import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import {
  clampFontScale,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  nativeChatMessageText
} from './mobile-native-chat-message-text'

describe('nativeChatMessageText', () => {
  it('joins text blocks and skips non-text blocks', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', name: 'Read', input: {} },
      { type: 'text', text: 'World' }
    ]
    expect(nativeChatMessageText(blocks)).toBe('Hello\n\nWorld')
  })

  it('returns an empty string when there is no prose', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'Read', input: {} }]
    expect(nativeChatMessageText(blocks)).toBe('')
  })

  it('trims surrounding whitespace', () => {
    expect(nativeChatMessageText([{ type: 'text', text: '  hi  ' }])).toBe('hi')
  })
})

describe('clampFontScale', () => {
  it('clamps below the minimum', () => {
    expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN)
  })

  it('clamps above the maximum', () => {
    expect(clampFontScale(5)).toBe(FONT_SCALE_MAX)
  })

  it('passes through an in-range value', () => {
    expect(clampFontScale(1.2)).toBe(1.2)
  })

  it('falls back to 1 for NaN', () => {
    expect(clampFontScale(Number.NaN)).toBe(1)
  })
})
