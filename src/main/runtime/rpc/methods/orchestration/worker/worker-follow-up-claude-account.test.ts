import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { claudePinnedLaunchError } from '../../../../../../shared/claude/claude-pinned-launch-error'
import { createOrchestrationWorkerReleaseHarness } from './testing/worker-release.test-support'

const PINNED = { id: 'acct-b', email: 'pinned@example.com', managedAuthRuntime: 'host' }

describe('a fresh follow-up to a worker started with --account', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
  })

  async function startPinnedWorkerThenLoseIt(): Promise<string> {
    h.setup()
    const accounts = [PINNED]
    vi.spyOn(h.runtime, 'getAccountsSnapshot').mockImplementation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the follow-up reads only the Claude account roster off this snapshot.
      () => ({ claude: { accounts, activeAccountId: null }, codex: null }) as never
    )
    vi.spyOn(h.runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'repo::worktree',
      path: '/repo/worktree',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const { dispatchId } = await h.startSettledWorker('succeeded', {
      agent: 'claude',
      account: PINNED.email
    })
    let gone = true
    const show = vi.mocked(h.runtime.showTerminal).getMockImplementation()!
    vi.mocked(h.runtime.showTerminal).mockImplementation(async (handle) => {
      if (gone && handle === 'term_worker') {
        throw new Error('terminal not found')
      }
      return show(handle)
    })
    vi.spyOn(h.runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
    h.inspectProcessLiveness.mockResolvedValue('exited')
    vi.mocked(h.runtime.createTerminal).mockClear()
    vi.mocked(h.runtime.createTerminal).mockImplementationOnce(async () => {
      gone = false
      return { handle: 'term_worker', worktreeId: 'repo::worktree', title: 'worker' }
    })
    return dispatchId
  }

  const send = (dispatchId: string) =>
    h.call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'More',
      body: 'and the docs'
    })

  it("starts the replacement Claude on the worker's account", async () => {
    const dispatchId = await startPinnedWorkerThenLoseIt()

    await expect(send(dispatchId)).resolves.toMatchObject({ delivery: 'started_fresh' })
    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'claude', claudeAccountId: PINNED.id })
    )
  })

  it('names the removed account instead of starting on another one', async () => {
    const dispatchId = await startPinnedWorkerThenLoseIt()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the follow-up reads only the Claude account roster off this snapshot.
    vi.mocked(h.runtime.getAccountsSnapshot).mockReturnValue({
      claude: { accounts: [], activeAccountId: null },
      codex: null
    } as never)

    await expect(send(dispatchId)).rejects.toMatchObject({
      code: 'worker_account_gone',
      message: expect.stringContaining(PINNED.email)
    })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('saves a refused pinned launch without the renderer marker', async () => {
    h.setup()
    vi.mocked(h.runtime.createTerminal).mockRejectedValue(
      claudePinnedLaunchError('account-missing', 'That Claude account no longer exists.')
    )
    const task = h.db.createTask({ spec: 'pinned start', runId: h.activeRunId })

    const result = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'claude'
    })

    expect(result).toMatchObject({ lastError: 'That Claude account no longer exists.' })
  })
})
