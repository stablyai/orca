import { describe, expect, it } from 'vitest'
import { COMMAND_SPECS } from './specs'

describe('Jira command surface', () => {
  it('lets agents read, create, comment, transition, assign, prioritize and edit labels', () => {
    const commands = new Set(COMMAND_SPECS.map((spec) => spec.path.join(' ')))
    for (const command of [
      'jira connection',
      'jira issue',
      'jira list',
      'jira search',
      'jira create',
      'jira project list',
      'jira project types',
      'jira project fields',
      'jira comment list',
      'jira comment add',
      'jira status list',
      'jira status set',
      'jira assignee list',
      'jira assignee set',
      'jira assignee clear',
      'jira priority list',
      'jira priority set',
      'jira priority clear',
      'jira label add',
      'jira label rm',
      'jira label set'
    ]) {
      expect(commands.has(command), command).toBe(true)
    }
  })
})
