import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { normalizeNativeChatUserText } from '../../shared/native-chat-image-transcript-markers'

const prompt = 'Summarize the failing tests.\n\nThen propose a fix for each one.'
const wrapped = `\n\n<pasted_content id="7e64">\n${prompt}\n</pasted_content id="7e64">\n`
function decode(text: string, role = 'user', array = false) {
  return decodeClaudeTranscriptLine(
    JSON.stringify({
      type: role,
      uuid: 'user',
      message: { content: array ? [{ type: 'text', text }] : text }
    }),
    'fallback'
  )!
}

describe('Claude whole-block paste envelope', () => {
  it.each([false, true])('decodes host user content (array=%s)', (array) => {
    expect(decode(wrapped, 'user', array).blocks).toEqual([{ type: 'text', text: prompt }])
  })
  it('accepts CRLF and a wrapper without ids', () => {
    expect(decode(`<pasted_content>\r\n${prompt}\r\n</pasted_content>`).blocks).toEqual([
      { type: 'text', text: prompt }
    ])
  })
  it('decodes a paste whose own text quotes differently identified or bare tags', () => {
    const quoted = `<pasted_content id="aa">\nx\n</pasted_content id="aa">\n</pasted_content>`
    expect(
      decode(`<pasted_content id="7e64">\n${quoted}\n</pasted_content id="7e64">`).blocks
    ).toEqual([{ type: 'text', text: quoted }])
  })
  it.each([
    `Explain this:\n${wrapped}`,
    `<pasted_content id="7e64">\n<pasted_content id="7e64">\nx\n</pasted_content id="7e64">`,
    `<pasted_content>\n<pasted_content id="aa">\nx\n</pasted_content id="aa">\n</pasted_content>`,
    wrapped.replace('id="7e64">\n', 'id="other">\n'),
    wrapped.replace('</pasted_content id="7e64">', '</pasted_content>'),
    wrapped.replace('<pasted_content id="7e64">', '<pasted_content>'),
    `${wrapped}\n${wrapped}`
  ])('preserves prose and nonmatching envelopes', (text) => {
    expect(decode(text).blocks).toEqual([{ type: 'text', text }])
  })
  it('leaves assistant text untouched', () => {
    expect(decode(wrapped, 'assistant').blocks).toEqual([{ type: 'text', text: wrapped }])
  })
  it('handles a large prompt in linear passes', () => {
    const text = 'line\n'.repeat(50_000)
    expect(
      normalizeNativeChatUserText(`<pasted_content id="a">\n${text}\n</pasted_content id="a">`)
    ).toBe(text.trim().replace(/\s+/g, ' '))
  })
})
