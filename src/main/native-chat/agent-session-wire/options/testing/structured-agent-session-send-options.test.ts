import { expect, it } from 'vitest'
import {
  captureStructuredExecutionOptions,
  openingMessageOptions
} from '../structured-agent-session-execution-options'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router-test-support'

it('inherits a saved Plan for older phone selections without adding model intent', () => {
  expect(
    captureStructuredExecutionOptions(
      {
        agents: claudeAndCodexAgents(),
        agent: 'claude',
        persistedOptions: { interactionMode: 'plan' }
      },
      undefined,
      {}
    )
  ).toEqual({ options: { interactionMode: 'plan', fastMode: 'false' } })
  expect(openingMessageOptions({ interactionMode: 'plan' })).toEqual({
    options: { interactionMode: 'plan' }
  })
})
