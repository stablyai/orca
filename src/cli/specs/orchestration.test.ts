import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

describe('orchestration send command spec', () => {
  it('documents valid message types and the question reply path', () => {
    const sendSpec = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration send'
    )

    expect(sendSpec?.notes).toEqual(
      expect.arrayContaining([
        'Valid --type values: status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat.',
        'To answer a worker question, use orchestration reply --id <msg_id> --body <text> with the same Orca CLI executable.'
      ])
    )
  })
})
