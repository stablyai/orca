import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../shared/terminal-exit-cause'

// Residual C (exit-wait subset): a disconnected PTY with no proven exit code is contact lost,
// not a death certificate. `RuntimeTerminalWait.wait` used to settle an 'exit' condition the
// instant `pty.connected` went false, regardless of whether any exit code was ever observed —
// and a stored `-1` (the unverified sentinel every disconnect stamps in) read identically to a
// real proven exit. Only a proven exit code may settle an exit wait.
const HANDLE = 'terminal-1'

function createExitWait(pty: RuntimePtyWorktreeRecord) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const shared = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => null,
    getFirstPartyAgentStatus: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...shared,
    intervalMs: 2000,
    getForegroundProcess: () => Promise.resolve(null),
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getLivePty: () => ({ pty }),
      getLiveLeaf: () => {
        throw new Error('not exercised: a live pty always wins getLivePty')
      },
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  return wait
}

describe('exit waits require a proven exit code', () => {
  it('never settles when the pty disconnected without a proven exit code', async () => {
    const pty = makeTuiIdlePty({ connected: false, lastExitCode: null })
    const wait = createExitWait(pty)

    await expect(wait.wait(HANDLE, { condition: 'exit', timeoutMs: 50 })).rejects.toThrow('timeout')
  })

  it('never settles when the disconnect only stamped the unverified sentinel code', async () => {
    const pty = makeTuiIdlePty({ connected: false, lastExitCode: UNVERIFIED_PROCESS_EXIT_CODE })
    const wait = createExitWait(pty)

    await expect(wait.wait(HANDLE, { condition: 'exit', timeoutMs: 50 })).rejects.toThrow('timeout')
  })

  it('still settles immediately once the host vouches for the exit code', async () => {
    const pty = makeTuiIdlePty({ connected: false, lastExitCode: 0 })
    const wait = createExitWait(pty)

    await expect(wait.wait(HANDLE, { condition: 'exit', timeoutMs: 50 })).resolves.toMatchObject({
      satisfied: true,
      status: 'exited',
      exitCode: 0
    })
  })
})
