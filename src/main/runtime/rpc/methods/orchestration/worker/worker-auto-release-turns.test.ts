import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { WorkerAutoReleaseActivity } from '../../../../orchestration/worker-auto-release-activity'
import type { AgentPhase } from '../../../../../../shared/agent-transitions'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const GRACE_MS = 2 * 60_000

describe('orchestration worker automatic release across turns and settings', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.useRealTimers()
  })

  function setupWithFakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    h.setup()
  }

  function moved(from: AgentPhase, to: AgentPhase) {
    return {
      kind: 'moved' as const,
      paneKey: h.workerPaneKey,
      workspace: { worktreeId: 'wt', sshHostId: null },
      from,
      to,
      at: Date.now(),
      transition: null
    }
  }

  async function expectClosedAfterFreshGrace(): Promise<void> {
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
  }

  it('runs no timer while auto-close is off and closes a due worker once it is back on', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const scheduler = getWorkerTerminalAutoReleaseScheduler(h.runtime)
    const claims = vi.spyOn(h.db, 'claimDueWorkerTerminalAutoReleases')

    h.db.workerAutoReleaseEnabled = () => false
    scheduler.rearm()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(claims).not.toHaveBeenCalled()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    h.db.workerAutoReleaseEnabled = () => true
    scheduler.rearm()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    )
  })

  it('suspends instead of claiming an agent in a turn at its deadline, so nothing is archived', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const inTurn = vi.spyOn(h.runtime, 'isWorkerAgentInTurn').mockReturnValue(true)
    vi.mocked(h.runtime.readTerminal).mockClear()

    await vi.advanceTimersByTimeAsync(GRACE_MS)

    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
    inTurn.mockReturnValue(false)
    new WorkerAutoReleaseActivity(() => h.db).observePane(moved('working', 'done'))
    await expectClosedAfterFreshGrace()
  })

  it('holds the countdown while a follow-up waits on the user', async () => {
    setupWithFakeClock()
    const activity = new WorkerAutoReleaseActivity(() => h.db)
    await h.startSettledWorker()

    activity.observePane(moved('done', 'working'))
    activity.observePane(moved('working', 'needs-you'))
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    activity.observePane(moved('needs-you', 'done'))
    await expectClosedAfterFreshGrace()
  })

  it('refuses to stop a kept worker without touching it, and stops it once auto-close is allowed', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startWorker()
    const keepOpen = (keep: boolean) =>
      h.call('orchestration.workerKeepOpen', { paneKey: h.workerPaneKey, keep })
    await keepOpen(true)

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).rejects.toMatchObject({ code: 'terminal_kept_open' })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(h.db.getDispatchContextById(dispatchId)?.capability_revoked_at).toBeNull()

    await keepOpen(false)
    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped' })
  })
})
