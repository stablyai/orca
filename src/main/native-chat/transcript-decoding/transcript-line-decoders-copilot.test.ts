import { expect, it } from 'vitest'
import { decodeCopilotTranscriptLine } from './transcript-line-decoders-copilot'

const line = (type: string, data: unknown, timestamp = '2026-01-02T03:04:05.000Z') =>
  JSON.stringify({ type, data, timestamp })

it('decodes a Copilot turn in file order', () => {
  expect(
    decodeCopilotTranscriptLine(line('user.message', { content: 'summarize this' }), 'a')
  ).toEqual({
    id: 'a',
    role: 'user',
    blocks: [{ type: 'text', text: 'summarize this' }],
    timestamp: Date.parse('2026-01-02T03:04:05.000Z'),
    source: 'transcript'
  })
  expect(
    decodeCopilotTranscriptLine(
      line('assistant.message', { content: [{ type: 'text', text: 'done' }] }),
      'b'
    )
  ).toEqual({
    id: 'b',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'done' }],
    timestamp: Date.parse('2026-01-02T03:04:05.000Z'),
    source: 'transcript'
  })
})

it('ignores injected context, subagent lines, fusion replays and bookkeeping', () => {
  expect(
    decodeCopilotTranscriptLine(
      line('user.message', { content: 'ask', transformedContent: 'ask plus context' }),
      'a'
    )?.blocks
  ).toEqual([{ type: 'text', text: 'ask' }])
  const ignored = [
    line('assistant.message', { content: 'subagent' }, '2026-01-02T03:04:05.000Z').replace(
      '{"type"',
      '{"agentId":"agent-1","type"'
    ),
    line('assistant.message', { content: 'replay', fusion: 'solver' }),
    line('session.start', { sessionId: 's' }),
    line('session.shutdown', { currentModel: 'm' })
  ]
  for (const record of ignored) {
    expect(decodeCopilotTranscriptLine(record, 'x')).toBeNull()
  }
})
