import { describe, expect, it } from 'vitest'
import { readClaudeTranscriptEntryUuid } from './claude-transcript-entry-uuid'

describe('Claude transcript entry uuid', () => {
  it('does not sample UUIDs from subagent stdout frames with a parent tool use', () => {
    expect(
      readClaudeTranscriptEntryUuid({
        type: 'assistant',
        uuid: 'subagent-assistant',
        parent_tool_use_id: 'parent-tool'
      })
    ).toBeNull()
    expect(
      readClaudeTranscriptEntryUuid({
        type: 'assistant',
        uuid: 'main-assistant',
        parent_tool_use_id: null
      })
    ).toBe('main-assistant')
  })
})
