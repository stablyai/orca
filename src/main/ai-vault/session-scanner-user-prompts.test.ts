import { describe, expect, it } from 'vitest'
import {
  addPreviewContent,
  addPreviewMessage,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession
} from './session-scanner-accumulator'

function makeAccumulator() {
  return createAccumulator({
    agent: 'claude',
    file: { path: '/tmp/session.jsonl', mtimeMs: 0, modifiedAt: new Date(0).toISOString() },
    sessionId: 'session-1'
  })
}

describe('session accumulator user prompts', () => {
  it('retains every user prompt while the preview stays capped at 5 messages', () => {
    const accumulator = makeAccumulator()
    for (let index = 1; index <= 8; index += 1) {
      addPreviewMessage(accumulator, { role: 'user', text: `prompt ${index}` })
      addPreviewMessage(accumulator, { role: 'assistant', text: `reply ${index}` })
    }
    expect(accumulator.previewMessages.length).toBe(5)
    expect(accumulator.userPrompts.map((prompt) => prompt.text)).toEqual([
      'prompt 1',
      'prompt 2',
      'prompt 3',
      'prompt 4',
      'prompt 5',
      'prompt 6',
      'prompt 7',
      'prompt 8'
    ])
    const session = finalizeSession(accumulator, 'darwin')
    expect(session?.userPrompts?.length).toBe(8)
  })

  it('records only non-blank user messages', () => {
    const accumulator = makeAccumulator()
    addPreviewMessage(accumulator, { role: 'assistant', text: 'hi' })
    addPreviewMessage(accumulator, { role: 'user', text: '   ' })
    addPreviewMessage(accumulator, { role: 'user', text: 'real prompt' })
    expect(accumulator.userPrompts.map((prompt) => prompt.text)).toEqual(['real prompt'])
  })

  it('deep-copies userPrompts when cloning so a cached snapshot cannot be mutated', () => {
    const accumulator = makeAccumulator()
    addPreviewMessage(accumulator, { role: 'user', text: 'a' })
    const clone = cloneSessionAccumulator(accumulator)
    addPreviewMessage(accumulator, { role: 'user', text: 'b' })
    expect(clone.userPrompts.map((prompt) => prompt.text)).toEqual(['a'])
    expect(accumulator.userPrompts.map((prompt) => prompt.text)).toEqual(['a', 'b'])
  })

  it('excludes tool_result records (stored as role:user) from user prompts', () => {
    const accumulator = makeAccumulator()
    // A real typed prompt (string content) is captured…
    addPreviewContent(accumulator, 'user', 'please refactor this', 1)
    // …but a Claude tool_result (array of tool_result blocks) is not.
    addPreviewContent(accumulator, 'user', [{ type: 'tool_result', content: 'command stdout' }], 2)
    expect(accumulator.userPrompts.map((prompt) => prompt.text)).toEqual(['please refactor this'])
    // The tool result still appears in the rolling preview.
    expect(accumulator.previewMessages.some((message) => message.text === 'command stdout')).toBe(
      true
    )
  })

  it('keeps the full prompt text (not the 220-char preview truncation)', () => {
    const accumulator = makeAccumulator()
    const longPrompt = 'x'.repeat(600)
    addPreviewContent(accumulator, 'user', longPrompt, 1)
    expect(accumulator.userPrompts[0]?.text.length).toBe(600)
    // The preview is still truncated with an ellipsis.
    expect(accumulator.previewMessages[0]?.text.endsWith('...')).toBe(true)
    expect(accumulator.previewMessages[0]?.text.length).toBeLessThanOrEqual(220)
  })

  it('drops tool_result blocks from a mixed user turn so tool output does not leak', () => {
    const accumulator = makeAccumulator()
    addPreviewContent(
      accumulator,
      'user',
      [
        { type: 'tool_result', content: 'big command stdout' },
        { type: 'text', text: 'now do X' }
      ],
      1
    )
    expect(accumulator.userPrompts.map((prompt) => prompt.text)).toEqual(['now do X'])
  })

  it('caps retained user prompts and evicts the oldest', () => {
    const accumulator = makeAccumulator()
    for (let index = 1; index <= 45; index += 1) {
      addPreviewMessage(accumulator, { role: 'user', text: `p${index}` })
    }
    expect(accumulator.userPrompts.length).toBe(25)
    expect(accumulator.userPrompts[0]?.text).toBe('p21')
    expect(accumulator.userPrompts.at(-1)?.text).toBe('p45')
  })
})
