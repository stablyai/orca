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
})

describe('readClaudeSubagentTranscriptEffort', () => {
  it('reads each agent id from its own transcript', async () => {
    const read = (agentId: string) =>
      readClaudeSubagentTranscriptEffort({ sessionTranscriptPath, agentId })

    await expect(read('a1')).resolves.toBe('low')
    await expect(read('b2')).resolves.toBe('high')
  })

  it('leaves an unobserved effort empty and refuses an id that is not a plain file name', async () => {
    await expect(
      readClaudeSubagentTranscriptEffort({ sessionTranscriptPath, agentId: 'c3' })
    ).resolves.toBeUndefined()
    await expect(
      readClaudeSubagentTranscriptEffort({ sessionTranscriptPath, agentId: '../escape' })
    ).resolves.toBeUndefined()
  })
})
