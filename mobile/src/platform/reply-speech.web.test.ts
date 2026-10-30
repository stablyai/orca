import { describe, expect, it } from 'vitest'
import { SPEECH_MAX_MARKDOWN_CHARS } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { limitedMarkdown } from './reply-speech.web'

describe('limitedMarkdown', () => {
  it('keeps a reply under the limit as it is', () => {
    expect(limitedMarkdown('Short reply.')).toBe('Short reply.')
  })

  it('closes a code block the limit cuts through', () => {
    const code = 'x'.repeat(SPEECH_MAX_MARKDOWN_CHARS)
    const limited = limitedMarkdown(`Intro\n\`\`\`ts\n${code}\n\`\`\`\nAfter`)
    expect(limited.length).toBeLessThanOrEqual(SPEECH_MAX_MARKDOWN_CHARS)
    expect(limited.endsWith('\n```')).toBe(true)
  })

  it('adds no fence when the cut falls outside a code block', () => {
    const limited = limitedMarkdown(
      `\`\`\`\ncode\n\`\`\`\n${'word '.repeat(SPEECH_MAX_MARKDOWN_CHARS)}`
    )
    expect(limited.length).toBeLessThanOrEqual(SPEECH_MAX_MARKDOWN_CHARS)
    expect(limited.endsWith('```')).toBe(false)
  })
})
