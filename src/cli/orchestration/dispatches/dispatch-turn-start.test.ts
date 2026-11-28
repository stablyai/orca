import { expect, test } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { describeDispatchTurnStart } from './dispatch-turn-start'

// #34010: a coordinator told "dispatched" while the preamble sat unsent in the worker's prompt.
test('an injected Dispatch reads as started only once its turn start was observed', () => {
  const dispatch = {
    id: 'ctx_1',
    task_id: 'task_1',
    status: 'dispatched',
    assignee_handle: 'term_worker'
  }
  const accepted: RuntimeTerminalPromptDelivery = {
    requestId: 'request_1',
    stages: ['input_accepted'],
    provider: 'claude',
    observation: 'supported',
    processIncarnation: 'incarnation_1',
    generation: 1,
    baselineWorkingSequence: 0
  }

  expect(describeDispatchTurnStart({ dispatch, injected: true, prompt: accepted }).turnStart).toBe(
    'unobserved'
  )

  const started = describeDispatchTurnStart({
    dispatch,
    injected: true,
    prompt: { ...accepted, stages: ['input_accepted', 'turn_started'] }
  })
  expect(started.turnStart).toBe('observed')
  expect(started.next).toBeUndefined()
})
