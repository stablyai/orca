import { describe, expect, it } from 'vitest'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'

describe('ClaudeSubagentIds with an earlier run journaled', () => {
  it("prefers what this run was told, and falls back to the earlier run's alias", () => {
    const ids = new ClaudeSubagentIds((toolUseId) =>
      toolUseId === 'toolu_spawn' || toolUseId === 'toolu_both' ? 'task-journaled' : null
    )
    ids.alias('toolu_both', 'task-live')
    expect(ids.canonical('toolu_both')).toBe('task-live')
    expect(ids.canonical('toolu_spawn')).toBe('task-journaled')
    expect(ids.isAnnounced('toolu_spawn')).toBe(true)
    expect(ids.isAnnounced('toolu_unknown')).toBe(false)
    expect(ids.canonical('toolu_unknown')).toBe('toolu_unknown')
  })
})
