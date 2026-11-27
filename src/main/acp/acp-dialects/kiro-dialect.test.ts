import { expect, it } from 'vitest'
import { acpSessionSlashCommand } from '../options/acp-session-slash-command'
import { KIRO_ACP_DIALECT } from './kiro-dialect'

it('classifies Kiro ACP skills separately from bundled custom agents', () => {
  expect(
    acpSessionSlashCommand(
      {
        name: 'tdd',
        description: 'Run test-driven workflow',
        input: { hint: 'optional context' },
        _meta: { kiro: { type: 'skill', resource: { resourceType: 'skill' } } }
      },
      KIRO_ACP_DIALECT,
      false
    )
  ).toEqual({
    name: 'tdd',
    kind: 'skill',
    description: 'Run test-driven workflow',
    argumentHint: 'optional context'
  })

  expect(
    acpSessionSlashCommand(
      {
        name: 'general-task-execution',
        description: 'General-purpose sub-agent',
        input: { hint: 'task to delegate' },
        _meta: { kiro: { type: 'custom-agent', resource: { resourceType: 'agent' } } }
      },
      KIRO_ACP_DIALECT,
      false
    )
  ).toEqual({
    name: 'general-task-execution',
    kind: 'command',
    description: 'General-purpose sub-agent',
    argumentHint: 'task to delegate'
  })
})
