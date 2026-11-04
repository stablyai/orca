import { describe, expect, it } from 'vitest'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'

describe('ClaudeSubagentIds', () => {
  it('drops the oldest alias past the bound and keeps the newest', () => {
    const ids = new ClaudeSubagentIds()
    for (let index = 0; index <= 512; index += 1) {
      ids.alias(`toolu_${index}`, `task-${index}`)
    }
    expect(ids.canonical('toolu_0')).toBe('toolu_0')
    expect(ids.canonical('toolu_512')).toBe('task-512')
    expect(ids.canonical('toolu_1')).toBe('task-1')
  })

  it('drops the oldest exclusion past the bound and keeps the newest', () => {
    const ids = new ClaudeSubagentIds()
    for (let index = 0; index <= 512; index += 1) {
      ids.exclude(`task-${index}`)
    }
    expect(ids.isExcluded('task-0')).toBe(false)
    expect(ids.isExcluded('task-512')).toBe(true)
    expect(ids.isExcluded('task-1')).toBe(true)
  })

  it('does not retain oversized aliases or exclusions', () => {
    const ids = new ClaudeSubagentIds()
    const oversized = 'x'.repeat(513)
    ids.alias(oversized, 'task-1')
    ids.alias('tool-1', oversized)
    ids.exclude(oversized)
    expect(ids.canonical(oversized)).toBe(oversized)
    expect(ids.canonical('tool-1')).toBe('tool-1')
    expect(ids.isExcluded(oversized)).toBe(false)
  })
})

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
