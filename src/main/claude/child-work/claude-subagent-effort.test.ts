import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  claudeTranscriptEffort,
  readClaudeSubagentTranscriptEffort
} from './claude-subagent-effort'

const sessionTranscriptPath = fileURLToPath(
  new URL('./__fixtures__/claude-subagent-effort/session.jsonl', import.meta.url)
)

describe('claudeTranscriptEffort', () => {
  it('reads the resolved effort from assistant rows', () => {
    expect(
      claudeTranscriptEffort(
        [
          '{"type":"user","message":{"role":"user"}}',
          '{"type":"assistant","message":{"model":"claude-sonnet-5-5"},"effort":"low"}'
        ].join('\n')
      )
    ).toBe('low')
  })

  it('reports nothing when no assistant row carries an effort', () => {
    expect(
      claudeTranscriptEffort('{"type":"assistant","message":{"model":"claude-haiku-5"}}')
    ).toBeUndefined()
  })

  it('ignores the partial rows a tail read can cut', () => {
    expect(
      claudeTranscriptEffort(
        [
          '{"type":"assistant","effort":"hig',
          '{"type":"assistant","message":{"model":"claude-opus-5-5"},"perTurnEffort":"medium"}'
        ].join('\n')
      )
    ).toBe('medium')
  })

  it('reads only the run after the latest prompt, past tool results and interruptions', () => {
    const rows = [
      '{"type":"user","message":{"role":"user","content":"Read files"}}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5-5"},"effort":"low"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5-5"},"effort":"medium"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}'
    ]
    expect(claudeTranscriptEffort(rows.join('\n'))).toBe('medium')

    const resumed = [
      ...rows,
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Continue"}]}}'
    ]
    expect(claudeTranscriptEffort(resumed.join('\n'))).toBeUndefined()
    expect(
      claudeTranscriptEffort(
        [
          ...resumed,
          '{"type":"assistant","message":{"model":"claude-sonnet-5-5"},"effort":"high"}'
        ].join('\n')
      )
    ).toBe('high')
  })
})

describe('readClaudeSubagentTranscriptEffort', () => {
  it('reads each agent id from its own transcript', async () => {
    const read = (agentId: string) =>
      readClaudeSubagentTranscriptEffort({ sessionTranscriptPath, agentId })

    await expect(read('a1')).resolves.toBe('low')
    await expect(read('b2')).resolves.toBe('high')
  })
})
