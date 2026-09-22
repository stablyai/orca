import { describe, expect, it } from 'vitest'
import {
  WORKER_RESUME_STATES,
  buildWorkerResumePrompt,
  classifyWorkerResumeDelivery,
  classifyWorkerResumePrecondition,
  describeWorkerResumeState,
  type WorkerResumePreconditionFacts
} from './worker-resume-state'

const IDLE: WorkerResumePreconditionFacts = {
  observation: 'live',
  turnRunning: false,
  awaitingHuman: false,
  unacknowledgedDelivery: false
}

describe('worker resume preconditions', () => {
  it('delivers only to an idle, reachable worker holding no unacknowledged batch', () => {
    expect(classifyWorkerResumePrecondition(IDLE)).toEqual({ deliver: true })
  })

  it('reports a running turn rather than folding a nudge into work in flight', () => {
    expect(classifyWorkerResumePrecondition({ ...IDLE, turnRunning: true })).toEqual({
      deliver: false,
      state: 'active_turn'
    })
  })

  it('reports a pending human decision as a denied action instead of writing past it', () => {
    expect(classifyWorkerResumePrecondition({ ...IDLE, awaitingHuman: true })).toEqual({
      deliver: false,
      state: 'denied_action'
    })
  })

  it('reports an unacknowledged batch rather than duplicating guidance the worker holds', () => {
    expect(classifyWorkerResumePrecondition({ ...IDLE, unacknowledgedDelivery: true })).toEqual({
      deliver: false,
      state: 'missing_acknowledgement'
    })
  })

  it.each(['exited', 'identity_changed'] as const)(
    'reports %s as a dead process',
    (observation) => {
      expect(classifyWorkerResumePrecondition({ ...IDLE, observation })).toEqual({
        deliver: false,
        state: 'exited_process'
      })
    }
  )

  it.each(['unverifiable', 'missing', 'unattached'] as const)(
    'reports %s as unknown liveness, never as death',
    (observation) => {
      expect(classifyWorkerResumePrecondition({ ...IDLE, observation })).toEqual({
        deliver: false,
        state: 'unknown_liveness'
      })
    }
  )

  it('lets a dead process outrank anything observed about its agent', () => {
    expect(
      classifyWorkerResumePrecondition({
        observation: 'exited',
        turnRunning: true,
        awaitingHuman: true,
        unacknowledgedDelivery: true
      })
    ).toEqual({ deliver: false, state: 'exited_process' })
  })

  it('lets lost contact outrank a stale agent status', () => {
    expect(
      classifyWorkerResumePrecondition({
        observation: 'unverifiable',
        turnRunning: true,
        awaitingHuman: true,
        unacknowledgedDelivery: true
      })
    ).toEqual({ deliver: false, state: 'unknown_liveness' })
  })
})

describe('worker resume delivery verdicts', () => {
  it('calls a proven turn start a resume', () => {
    expect(
      classifyWorkerResumeDelivery({ route: 'terminal', receipted: true, verdict: 'observed' })
    ).toBe('resumed')
  })

  it('calls an accepted write on a provider with no turn-start signal a resume', () => {
    expect(
      classifyWorkerResumeDelivery({ route: 'terminal', receipted: true, verdict: 'unsupported' })
    ).toBe('resumed')
  })

  it('calls an accepted prompt with no turn a queued prompt', () => {
    expect(
      classifyWorkerResumeDelivery({ route: 'terminal', receipted: true, verdict: 'unobserved' })
    ).toBe('queued_prompt')
  })

  it('calls a permission prompt raised after the write a denied action', () => {
    expect(
      classifyWorkerResumeDelivery({ route: 'terminal', receipted: true, verdict: 'permission' })
    ).toBe('denied_action')
  })

  it('calls an accepted send that returned no receipt a missing acknowledgement', () => {
    expect(
      classifyWorkerResumeDelivery({ route: 'terminal', receipted: false, verdict: 'observed' })
    ).toBe('missing_acknowledgement')
  })

  it.each([
    ['accepted', 'resumed'],
    ['rejected', 'denied_action'],
    ['unknown', 'missing_acknowledgement']
  ] as const)('maps a structured %s dispatch to %s', (dispatchState, state) => {
    expect(classifyWorkerResumeDelivery({ route: 'structured', dispatchState })).toBe(state)
  })

  it.each([
    ['blocked_on_human', 'denied_action'],
    ['not_writable', 'exited_process'],
    ['unprovable', 'unknown_liveness']
  ] as const)('maps a %s refusal to %s', (refusal, state) => {
    expect(classifyWorkerResumeDelivery({ route: 'refused', refusal })).toBe(state)
  })
})

describe('the reported vocabulary', () => {
  it('names the six non-resumed states distinctly, with no synonyms', () => {
    expect([...WORKER_RESUME_STATES]).toEqual([
      'resumed',
      'queued_prompt',
      'missing_acknowledgement',
      'active_turn',
      'denied_action',
      'exited_process',
      'unknown_liveness'
    ])
    const described = WORKER_RESUME_STATES.map(describeWorkerResumeState)
    expect(new Set(described).size).toBe(WORKER_RESUME_STATES.length)
  })
})

describe('the resume prompt', () => {
  it('names the worker its own Dispatch mailbox rather than telling it to poll', () => {
    const prompt = buildWorkerResumePrompt({
      cliCommand: 'orca',
      workerHandle: 'term_worker',
      dispatchId: 'ctx_1',
      note: 'rebase first'
    })

    expect(prompt).toContain(
      'orca orchestration check --terminal term_worker --dispatch ctx_1 --json'
    )
    expect(prompt).toContain('rebase first')
  })
})
