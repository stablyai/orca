import { describe, expect, it } from 'vitest'
import {
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from '../../shared/native-chat-image-transcript-markers'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

const COMPOSER_TEXT = 'line 000 xxxxxxxxxx\nline 001 xxxxxxxxxx\nline 002 xxxxxxxxxx'

// Matches the string-content shape observed when a TUI records Ctrl+U with the prompt.
const MOBILE_SEND_LINE = JSON.stringify({
  type: 'user',
  uuid: 'synthetic-user-turn',
  message: { role: 'user', content: `\u0015${COMPOSER_TEXT}` }
})

describe('decodeClaudeTranscriptLine on a mobile-sent prompt', () => {
  it('keeps the Ctrl+U byte the TUI pasted into the prompt', () => {
    const message = decodeClaudeTranscriptLine(MOBILE_SEND_LINE, 'fallback')
    expect(message?.role).toBe('user')
    expect(message?.blocks[0]).toEqual({
      type: 'text',
      text: `\u0015${COMPOSER_TEXT}`
    })
  })

  it('normalizes to the composer text so the optimistic echo can retire', () => {
    const message = decodeClaudeTranscriptLine(MOBILE_SEND_LINE, 'fallback')!
    expect(normalizedNativeChatUserMessageText(message)).toBe(
      normalizeNativeChatUserText(COMPOSER_TEXT)
    )
  })
})
