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

describe('orchestration worker-start command spec', () => {
  const startSpec = ORCHESTRATION_COMMAND_SPECS.find(
    (spec) => spec.path.join(' ') === 'orchestration worker-start'
  )

  it('offers no flag for the worker mode, because settings decide it', () => {
    expect(startSpec?.allowedFlags).not.toContain('structured')
    expect(startSpec?.usage).not.toContain('--structured')
    expect(startSpec?.notes?.join('\n')).not.toContain('--structured')
  })

  it('documents the settings default and the fallback that keeps every dispatch working', () => {
    const notes = startSpec?.notes?.join('\n') ?? ''
    expect(notes).toContain('follows your own setting for new agent tabs')
    expect(notes).toContain('starts a terminal agent worker instead')
  })
})
