import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { WorkerAutoReleaseActivity } from '../../../../orchestration/worker-auto-release-activity'
import type { AgentPhase } from '../../../../../../shared/agent-transitions'

const GRACE_MS = 2 * 60_000

describe('orchestration worker automatic release', () => {
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

  it.each(['succeeded', 'failed'] as const)(
    'releases a %s worker once its grace period ends and keeps its output readable',
    async (outcome) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker(outcome)
      await expect(
        h.call('orchestration.workerShow', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        autoReleaseAt: '2026-10-27T12:02:00Z',
        terminalResource: { autoReleaseAt: '2026-10-27T12:02:00Z' },
        projection: { nextAction: { kind: 'none' } }
      })

      await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)

      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
      expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      })
    }
  )

  it('never extends the deadline for a repeated worker_done', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startSettledWorker()
    const armed = h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at
    await vi.advanceTimersByTimeAsync(60_000)

    h.settle(taskId, dispatchId, 'succeeded')

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(armed)
  })

  it('hands a terminal reused during the grace period to the new Dispatch', async () => {
    setupWithFakeClock()
    const settled = await h.startSettledWorker()

    const reuse = await h.startWorker({ terminal: 'term_worker' })
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(settled.dispatchId)).toBeUndefined()
    expect(h.db.getWorkerTerminalResourceByOwner(reuse.dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
  })

  it('keeps a terminal worker-retain claimed before the deadline', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()

    await h.call('orchestration.workerRetain', { dispatch: dispatchId })
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      auto_release_at: null
    })
  })

  it("closes a worker the user typed into on time; an older client's typing report keeps nothing", async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()

    await expect(
      h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
    ).resolves.toEqual({ changed: 0 })
    await vi.advanceTimersByTimeAsync(GRACE_MS)

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    )
  })

  const keepOpen = (keep: boolean): Promise<unknown> =>
    h.call('orchestration.workerKeepOpen', { paneKey: h.workerPaneKey, keep })

  it('keeps a worker kept open while it ran past its finish, a coordinator release and reuse', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startWorker()
    await expect(
      h.call('orchestration.workerAutoClose', { paneKey: h.workerPaneKey })
    ).resolves.toEqual({ autoClose: { kept: false, closesAt: null } })

    await expect(keepOpen(true)).resolves.toEqual({ autoClose: { kept: true } })
    h.settle(taskId, dispatchId, 'succeeded')
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_kept' })
    await expect(h.startWorker({ terminal: 'term_worker' })).rejects.toThrow()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.retained_reason).toBe('user_kept')
  })

  it('starts a fresh countdown when the user allows auto-close again', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    await keepOpen(true)
    await vi.advanceTimersByTimeAsync(GRACE_MS + 30_000)

    await expect(keepOpen(false)).resolves.toEqual({
      autoClose: { kept: false, closesAt: '2026-10-27T12:04:30Z' }
    })
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    )
  })

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

  it('holds the countdown while a follow-up turn works and restarts it when the agent rests', async () => {
    setupWithFakeClock()
    const activity = new WorkerAutoReleaseActivity(() => h.db)
    await h.startSettledWorker()
    await vi.advanceTimersByTimeAsync(60_000)

    activity.observePane(moved('done', 'working'))
    await expect(
      h.call('orchestration.workerAutoClose', { paneKey: h.workerPaneKey })
    ).resolves.toEqual({ autoClose: { kept: false, closesAt: null } })
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    activity.observePane(moved('working', 'done'))
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
  })

  it('never closes an agent still working when its deadline comes', async () => {
    setupWithFakeClock()
    const working = vi.spyOn(h.runtime, 'isWorkerAgentInTurn').mockReturnValue(true)
    const { dispatchId } = await h.startSettledWorker()

    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
    expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    working.mockReturnValue(false)
    new WorkerAutoReleaseActivity(() => h.db).observePane(moved('working', 'done'))
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
  })

  it('does not arm a worker retained before it reported', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startWorker()
    await h.call('orchestration.workerRetain', { dispatch: dispatchId })

    h.settle(taskId, dispatchId, 'succeeded')
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['silent', async () => (await h.startWorker()).dispatchId],
    [
      'abandoned',
      async () => {
        const { dispatchId } = await h.startWorker()
        await h.call('orchestration.workerAbandon', { dispatch: dispatchId })
        return dispatchId
      }
    ],
    [
      'pre-upgrade settled',
      async () => {
        const { dispatchId } = await h.startSettledWorker()
        h.db.db
          .prepare(
            'UPDATE worker_terminal_resources SET auto_release_at = NULL, auto_release_dispatch_id = NULL WHERE owner_dispatch_id = ?'
          )
          .run(dispatchId)
        return dispatchId
      }
    ]
  ] as const)('leaves a %s worker to manual release', async (_state, start) => {
    setupWithFakeClock()
    const dispatchId = await start()

    getWorkerTerminalAutoReleaseScheduler(h.runtime).rearm()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
  })

  describe('across a restart', () => {
    let userDataDir: string

    beforeEach(() => {
      userDataDir = mkdtempSync(join(tmpdir(), 'orca-auto-release-restart-'))
    })
    afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

    function setupFileBacked(): void {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
      h.setup({ userDataDir })
    }

    async function expectReadableArchive(dispatchId: string): Promise<void> {
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      })
    }

    it('releases a deadline missed while the app was closed once, when the database reopens', async () => {
      setupFileBacked()
      const { dispatchId } = await h.startSettledWorker()

      h.restart()
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      vi.setSystemTime(Date.now() + 2 * GRACE_MS)
      h.restart()
      await vi.advanceTimersByTimeAsync(0)

      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
      await expectReadableArchive(dispatchId)

      h.restart()
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    })

    it.each(['requested', 'releasing'] as const)(
      'finishes an automatic release interrupted while %s after a restart',
      async (interruptedAt) => {
        setupFileBacked()
        const { dispatchId } = await h.startSettledWorker()
        // Hold the step after which a crash leaves the row in this state.
        const held =
          interruptedAt === 'requested'
            ? vi.mocked(h.runtime.readTerminal).mockReturnValue(new Promise(() => {}))
            : vi.mocked(h.runtime.closeTerminal).mockReturnValue(new Promise(() => {}))
        await vi.advanceTimersByTimeAsync(GRACE_MS)
        await vi.waitFor(() => expect(held).toHaveBeenCalled())
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(interruptedAt)

        h.restart()
        await reconcileRequestedWorkerTerminalReleases(h.runtime)
        await reconcileRequestedWorkerTerminalReleases(h.runtime)

        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
        expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
        await expectReadableArchive(dispatchId)
      }
    )
  })

  describe('chat workers', () => {
    const chatPaneKey = 'structured-agent-session-s1:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    function startChatWorker(): { taskId: string; dispatchId: string } {
      const started = h.db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'chat worker',
        taskRunId: 'run_legacy_local',
        startOptions: {}
      })
      h.db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'structworker_1',
        paneKey: chatPaneKey,
        processIncarnation: 'structured:s1',
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
        worktreeId: 'wt',
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      h.db.markWorkerDispatchReady(started.dispatch.id)
      return { taskId: started.task.id, dispatchId: started.dispatch.id }
    }

    function startSettledChatWorker(): string {
      const { taskId, dispatchId } = startChatWorker()
      h.settle(taskId, dispatchId, 'succeeded')
      return dispatchId
    }

    const resting = () => false

    const keepChat = (keep: boolean): Promise<unknown> =>
      h.call('orchestration.workerKeepOpen', { sessionId: 's1', keep })

    it('arms a chat worker on worker_done like a terminal worker', () => {
      setupWithFakeClock()

      const dispatchId = startSettledChatWorker()

      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(
        '2026-10-27 12:02:00'
      )
    })

    function claimAndCommitChatRelease(dispatchId: string): string {
      h.db.claimDueWorkerTerminalAutoReleases(Date.now() + GRACE_MS)
      const resourceId = h.db.getWorkerTerminalResourceByOwner(dispatchId)!.id
      h.db.commitWorkerTerminalArchiveForRelease({
        dispatchId,
        resourceId,
        kind: 'transcript_pin',
        content: '{}',
        archiveSource: 'transcript',
        archiveStatus: 'captured'
      })
      return resourceId
    }

    it('lets Keep open after the archive commit win until the close is admitted, then not', async () => {
      setupWithFakeClock()
      const kept = claimAndCommitChatRelease(startSettledChatWorker())
      await expect(keepChat(true)).resolves.toEqual({ autoClose: { kept: true } })
      expect(h.db.admitWorkerChatReleaseClose(kept, resting)).toBe(false)

      const closing = claimAndCommitChatRelease(startSettledChatWorker())
      expect(h.db.admitWorkerChatReleaseClose(closing, resting)).toBe(true)
      await keepChat(true)
      expect(h.db.getWorkerTerminalResource(closing)?.release_state).toBe('releasing')
    })

    it('lets a turn begun before Stop call off an automatic chat close, but not an explicit one that joined it', async () => {
      setupWithFakeClock()
      const inTurn = () => true
      const automatic = claimAndCommitChatRelease(startSettledChatWorker())
      expect(h.db.admitWorkerChatReleaseClose(automatic, inTurn)).toBe(false)
      expect(h.db.getWorkerTerminalResource(automatic)?.release_state).toBe('not_requested')

      const dispatchId = startSettledChatWorker()
      const joined = claimAndCommitChatRelease(dispatchId)
      h.db.requestWorkerTerminalRelease(dispatchId)
      expect(h.db.admitWorkerChatReleaseClose(joined, inTurn)).toBe(true)
    })

    it('keeps a close that began final when the agent works again: its archive stays', () => {
      setupWithFakeClock()
      const dispatchId = startSettledChatWorker()
      const resourceId = claimAndCommitChatRelease(dispatchId)

      h.db.suspendWorkerTerminalAutoRelease(chatPaneKey)

      expect(h.db.getWorkerTerminalResource(resourceId)?.release_state).toBe('releasing')
      expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeDefined()
    })
  })
})
