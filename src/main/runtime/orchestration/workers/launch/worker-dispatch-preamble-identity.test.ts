// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble, type PreambleParams } from './worker-dispatch-preamble'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'

const BASE: PreambleParams = {
  taskId: 'task_abc123',
  dispatchId: 'ctx_def456',
  taskSpec: 'Do the thing.',
  coordinatorHandle: 'term_coordinator',
  workerHandle: 'term_worker',
  workerKind: 'prompt-returning-agent'
}

// One worker in #43477 had to work out which handle was whose: every command uses the worker's
// own handle as --from, but only the coordinator's handle carried a label.
describe('dispatch preamble identity lines', () => {
  it('names a terminal worker its own handle', () => {
    expect(buildDispatchPreamble(BASE)).toContain('Your terminal handle is: term_worker')
  })

  it('keeps labeling the coordinator handle as theirs', () => {
    const preamble = buildDispatchPreamble(BASE)
    expect(preamble).toContain("Your coordinator's terminal handle is: term_coordinator")
    expect(buildDispatchPreamble({ ...BASE, coordinatedFrom: 'Peer Mac' })).toContain(
      'You are coordinated from Peer Mac'
    )
  })

  it('keeps naming session workers by their session ID instead', () => {
    const preamble = buildDispatchPreamble({
      ...BASE,
      workerHandle: `${ORCA_SESSION_ADDRESS_PREFIX}session-1`
    })
    expect(preamble).toContain(`Your Orca session ID is: ${ORCA_SESSION_ADDRESS_PREFIX}session-1`)
    expect(preamble).not.toContain('Your terminal handle is:')
  })
})
