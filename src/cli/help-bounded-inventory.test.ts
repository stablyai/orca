import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from './help'
import { ORCHESTRATION_COMMAND_SPECS } from './specs/orchestration'

describe('bounded task inventory help', () => {
  it('describes the task-list cursor as an opaque pagination token', () => {
    const taskList = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration task-list'
    )

    const help = formatCommandHelp(taskList!)

    expect(help).toContain('--cursor <opaque>')
    expect(help).toContain('Opaque pagination cursor from a previous bounded task-list page')
    expect(help).not.toContain('Line cursor from a previous read')
  })
})
