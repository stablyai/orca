import { expect, it } from 'vitest'
import {
  structuredAgentConfiguredArgs,
  withoutStructuredAgentEffortArgs
} from './structured-agent-configured-args'

it('refuses effort in Claude settings without discarding unrelated settings', () => {
  expect(() =>
    withoutStructuredAgentEffortArgs('claude', [
      '--settings',
      '{"effortLevel":"high","fastMode":true}'
    ])
  ).toThrow('cannot safely omit effort')
  expect(() =>
    structuredAgentConfiguredArgs(
      'claude',
      {
        agentDefaultArgs: { claude: `--settings '{"effortLevel":"high","fastMode":true}'` }
      },
      'linux',
      true
    )
  ).toThrow('cannot safely omit effort')
  expect(withoutStructuredAgentEffortArgs('claude', ['--settings', '{"fastMode":true}'])).toEqual([
    '--settings',
    '{"fastMode":true}'
  ])
})
