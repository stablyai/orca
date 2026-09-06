import { describe, expect, it } from 'vitest'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'

describe('ClaudeSubagentIds', () => {
  it('resolves an aliased tool id to its task, and an unaliased id to itself', () => {
    const ids = new ClaudeSubagentIds()
    ids.alias('toolu_1', 'task-1')
    expect(ids.canonical('toolu_1')).toBe('task-1')
    expect(ids.canonical('toolu_unknown')).toBe('toolu_unknown')
  })

  it('remembers an exclusion under either of the ids that named it', () => {
    const ids = new ClaudeSubagentIds()
    ids.exclude('task-bash')
    expect(ids.isExcluded('toolu_bash', 'task-bash')).toBe(true)
    expect(ids.isExcluded(null, null)).toBe(false)
    expect(ids.isExcluded('task-agent')).toBe(false)
  })

  it('drops the oldest alias past the bound and keeps the newest', () => {
    const ids = new ClaudeSubagentIds()
    for (let index = 0; index <= 512; index += 1) {
      ids.alias(`toolu_${index}`, `task-${index}`)
    }
    // Evicted: the id now stands only for itself.
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

  it('forgets everything on clear', () => {
    const ids = new ClaudeSubagentIds()
    ids.alias('toolu_1', 'task-1')
    ids.exclude('task-1')
    ids.clear()
    expect(ids.canonical('toolu_1')).toBe('toolu_1')
    expect(ids.isExcluded('task-1')).toBe(false)
  })
})
