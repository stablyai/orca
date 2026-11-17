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

// Workers guess flags from the examples they are shown; check is the one command that takes
// --terminal instead of --from, so its real syntax must appear unconditionally (#43477).
describe('dispatch preamble check command example', () => {
  it('shows check with its real --terminal syntax in the command block', () => {
    const preamble = buildDispatchPreamble(BASE)
    expect(preamble).toContain('orca orchestration check --terminal term_worker')
    // The example teaches the flag difference, since every other command uses --from.
    expect(preamble).toContain('check is the one command that takes --terminal')
    expect(preamble).not.toContain('orchestration check --from')
  })

  it('shows check even when no mail is waiting at dispatch time', () => {
    const preamble = buildDispatchPreamble({ ...BASE, unreadMail: false })
    expect(preamble).toContain('orca orchestration check --terminal term_worker')
  })

  it('omits the check command for chat workers, whose mail arrives as input', () => {
    const preamble = buildDispatchPreamble({
      ...BASE,
      workerHandle: `${ORCA_SESSION_ADDRESS_PREFIX}session-1`
    })
    // The post-done prose still names check; only the invocable example must be absent.
    expect(preamble).not.toContain('check --terminal')
  })
})
