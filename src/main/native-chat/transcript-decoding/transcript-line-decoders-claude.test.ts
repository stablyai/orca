import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

function assistantLine(model: string, isSidechain = false): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain,
    uuid: `row-${model}`,
    timestamp: '2026-11-16T08:00:00.000Z',
    effort: 'xhigh',
    message: { id: 'msg-1', role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }] }
  })
}

describe('decodeClaudeTranscriptLine', () => {
  it('keeps the serving model and effort on responses, not on CLI-written or subagent rows', () => {
    const response = decodeClaudeTranscriptLine(assistantLine('claude-opus-5-5'), 'fallback')
    const synthetic = decodeClaudeTranscriptLine(assistantLine('<synthetic>'), 'fallback')
    const subagent = decodeClaudeTranscriptLine(assistantLine('claude-haiku-5-5', true), 'fallback')

    expect(response).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(synthetic?.model).toBeUndefined()
    expect(synthetic?.effort).toBeUndefined()
    expect(subagent?.model).toBeUndefined()
  })
})
