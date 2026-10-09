import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

// Why: the polls' waits are not what these tests are about; an hour-long delete runs instantly.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }))

import { main } from './index'
import { RuntimeClientError, RuntimeRequestNotSentError } from './runtime/types'
import { okFixture, queueFixtures } from './test-fixtures'

const WORKTREE_ID = 'repo::/tmp/wt-1'

describe('worktree rm reports the removal outcome, not its acceptance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let priorExitCode: typeof process.exitCode

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    priorExitCode = process.exitCode
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    process.exitCode = priorExitCode
  })

  const printed = (): string =>
    [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.join(' ')).join('\n')

  function removeReplying(reply: Record<string, unknown>, ...states: unknown[]): void {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { id: WORKTREE_ID, hostId: 'local' } }),
      okFixture('req_rm', reply),
      ...states.map((state, index) => okFixture(`req_state_${index}`, state))
    )
  }

  const run = (...extra: string[]): Promise<void> =>
    main(['worktree', 'rm', '--worktree', 'id:wt-1', ...extra], '/tmp/repo')

  const removalStateCalls = () =>
    callMock.mock.calls.filter(([method]) => method === 'worktree.removalState')

  it('passes through a removal the host finished before replying, without polling', async () => {
    removeReplying({ removed: true })

    await run('--json')

    expect(removalStateCalls()).toHaveLength(0)
    expect(JSON.parse(printed()).result).toEqual({ removed: true })
  })

  it('polls a background delete until it is gone, however long that takes', async () => {
    const stillRemoving = Array.from({ length: 3_600 }, () => ({ state: 'removing' }))
    removeReplying({ removed: true, removing: true }, ...stillRemoving, { state: 'removed' })

    await run('--json')

    expect(removalStateCalls()).toHaveLength(3_601)
    expect(removalStateCalls()[0]).toEqual([
      'worktree.removalState',
      { worktreeId: WORKTREE_ID, hostId: 'local' }
    ])
    expect(JSON.parse(printed()).result).toEqual({ removed: true })
    expect(process.exitCode).not.toBe(1)
  })

  it('reports the branch the finished delete kept', async () => {
    removeReplying(
      { removed: true, removing: true },
      { state: 'removed', preservedBranch: { branchName: 'feature', head: 'abc' } }
    )

    await run()

    expect(printed()).toContain('local branch "feature" was kept')
    expect(printed()).toContain('removed: true')
  })

  it("exits non-zero with Git's error when the delete fails", async () => {
    removeReplying(
      { removed: true, removing: true },
      { state: 'removing' },
      { state: 'failed', message: 'Failed to delete worktree at /tmp/wt-1: Permission denied' }
    )

    await run('--json')

    expect(process.exitCode).toBe(1)
    expect(printed()).toContain('worktree_removal_failed')
    expect(printed()).toContain('Failed to delete worktree at /tmp/wt-1: Permission denied')
  })

  it('exits non-zero when the delete ended with the workspace still there', async () => {
    removeReplying({ removed: true, removing: true }, { state: 'present' })

    await run('--json')

    expect(process.exitCode).toBe(1)
    expect(printed()).toContain('Orca did not remove id:wt-1')
  })

  it('never reports an older host acceptance as removed', async () => {
    removeReplying({ removed: true, removing: true })
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: worktree.removalState')
    )

    await run('--json')

    expect(JSON.parse(printed()).result).toEqual({ removed: false, removing: true })
    expect(process.exitCode).not.toBe(1)
  })

  it('says in plain output that an older host is still deleting the checkout', async () => {
    removeReplying({ removed: true, removing: true })
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: worktree.removalState')
    )

    await run()

    expect(printed()).toBe(
      'removed: false\nOrca accepted the removal and is still deleting the checkout; this Orca version does not report when it finishes.'
    )
  })

  it.each(['runtime_unavailable', 'remote_runtime_unavailable'])(
    'rides out dropped connections (%s) and keeps waiting',
    async (code) => {
      removeReplying({ removed: true, removing: true })
      const drop = (): void => {
        callMock.mockRejectedValueOnce(new RuntimeClientError(code, 'closed'))
      }
      drop()
      drop()
      drop()
      drop()
      queueFixtures(callMock, okFixture('req_state_1', { state: 'removing' }))
      // The count resets on an answer, so four more drops after it still wait it out.
      drop()
      drop()
      drop()
      drop()
      queueFixtures(callMock, okFixture('req_state_2', { state: 'removed' }))

      await run('--json')

      expect(JSON.parse(printed()).result).toEqual({ removed: true })
    }
  )

  it.each([
    ['runtime_unavailable', 5],
    ['remote_runtime_unavailable', 5],
    ['runtime_timeout', 1]
  ])(
    'says the removal may still be running when Orca stops answering (%s)',
    async (code, failures) => {
      removeReplying({ removed: true, removing: true })
      for (let index = 0; index < failures; index += 1) {
        callMock.mockRejectedValueOnce(new RuntimeClientError(code, 'no answer'))
      }

      await run('--json')

      expect(process.exitCode).toBe(1)
      expect(printed()).toContain('worktree_removal_unconfirmed')
      expect(printed()).toContain('the Orca app stopped responding')
      expect(printed()).toContain(
        'The removal may still be running; once Orca responds, run `orca worktree rm --worktree id:wt-1` again to wait for it.'
      )
    }
  )

  it('does not show a raw error when the read itself fails', async () => {
    removeReplying({ removed: true, removing: true })
    callMock.mockRejectedValueOnce(new RuntimeClientError('runtime_error', 'selector_ambiguous'))

    await run()

    expect(process.exitCode).toBe(1)
    expect(printed()).toContain('could not report how it ended')
    expect(printed()).not.toContain('selector_ambiguous')
  })

  describe('when the connection drops before the delete request is answered', () => {
    const rmCalls = () => callMock.mock.calls.filter(([method]) => method === 'worktree.rm')
    const dropped = () => new RuntimeClientError('runtime_unavailable', 'closed before responding')

    function showThenDrop(): void {
      queueFixtures(
        callMock,
        okFixture('req_show', { worktree: { id: WORKTREE_ID, hostId: 'local' } })
      )
      callMock.mockRejectedValueOnce(dropped())
    }

    it('waits on a delete the host accepted, without sending it again', async () => {
      showThenDrop()
      queueFixtures(
        callMock,
        okFixture('req_state_0', { state: 'removing' }),
        okFixture('req_state_1', { state: 'removed' })
      )

      await run('--json')

      expect(rmCalls()).toHaveLength(1)
      expect(JSON.parse(printed()).result).toEqual({ removed: true })
    })

    it('sends it again when the host is not deleting the workspace', async () => {
      showThenDrop()
      queueFixtures(
        callMock,
        okFixture('req_state_0', { state: 'present' }),
        okFixture('req_rm', { removed: true })
      )

      await run('--json')

      expect(rmCalls()).toHaveLength(2)
      expect(JSON.parse(printed()).result).toEqual({ removed: true })
    })

    it('never sends it again once an archive hook may have run', async () => {
      showThenDrop()
      queueFixtures(callMock, okFixture('req_state_0', { state: 'present' }))

      await run('--run-hooks', '--json')

      expect(rmCalls()).toHaveLength(1)
      expect(process.exitCode).toBe(1)
      expect(printed()).toContain(
        'It was not sent again because its archive hook may already have run'
      )
    })

    it('never sends it again blind when the host cannot be asked', async () => {
      showThenDrop()
      for (let index = 0; index < 8; index += 1) {
        callMock.mockRejectedValueOnce(dropped())
      }

      await run('--json')

      expect(rmCalls()).toHaveLength(1)
      expect(process.exitCode).toBe(1)
      expect(printed()).toContain('worktree_removal_unconfirmed')
      expect(printed()).toContain(
        'If it received the request, the removal finishes when Orca runs again'
      )
    })

    it('sends a request that provably never left again, without asking the host', async () => {
      queueFixtures(
        callMock,
        okFixture('req_show', { worktree: { id: WORKTREE_ID, hostId: 'local' } })
      )
      callMock.mockRejectedValueOnce(
        new RuntimeRequestNotSentError('runtime_unavailable', 'Could not connect')
      )
      queueFixtures(callMock, okFixture('req_rm', { removed: true }))

      await run('--json')

      expect(rmCalls()).toHaveLength(2)
      expect(removalStateCalls()).toHaveLength(0)
      expect(JSON.parse(printed()).result).toEqual({ removed: true })
    })

    it('gives the original error when Orca is not running at all', async () => {
      queueFixtures(
        callMock,
        okFixture('req_show', { worktree: { id: WORKTREE_ID, hostId: 'local' } })
      )
      for (let index = 0; index < 5; index += 1) {
        callMock.mockRejectedValueOnce(
          new RuntimeRequestNotSentError(
            'runtime_unavailable',
            'Could not connect to the running Orca app.'
          )
        )
      }

      await run('--json')

      expect(rmCalls()).toHaveLength(5)
      expect(removalStateCalls()).toHaveLength(0)
      expect(process.exitCode).toBe(1)
      expect(printed()).toContain('Could not connect to the running Orca app.')
    })

    it('gives the original error when an older host cannot say whether it got the request', async () => {
      showThenDrop()
      callMock.mockRejectedValueOnce(
        new RuntimeClientError('method_not_found', 'Unknown method: worktree.removalState')
      )

      await run('--json')

      expect(rmCalls()).toHaveLength(1)
      expect(process.exitCode).toBe(1)
      expect(printed()).toContain('closed before responding')
    })
  })
})
