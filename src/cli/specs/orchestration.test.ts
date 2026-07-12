import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

describe('orchestration task-list command specification', () => {
  it('advertises bounded inventory pagination separately from legacy filters', () => {
    const taskList = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration task-list'
    )

    expect(taskList?.usage).toContain('--limit <1..1000>')
    expect(taskList?.usage).toContain('--cursor <opaque>')
    expect(taskList?.allowedFlags).toEqual(expect.arrayContaining(['limit', 'cursor']))
    expect(taskList?.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--limit cannot be combined with --status, --ready, or --brief')
      ])
    )
  })
})
