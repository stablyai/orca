import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

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
})
