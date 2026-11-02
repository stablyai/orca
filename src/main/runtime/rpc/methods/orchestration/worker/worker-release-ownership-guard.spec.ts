import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-types'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

export function registerWorkerReleaseOwnershipGuardTests(): void {
  describe('workerRelease on a retained resource whose process exited', () => {
    const harness = createOrchestrationWorkerReleaseHarness()
    beforeEach(() => harness.setup())
    afterEach(() => harness.cleanup())

    it('does not release a terminal the user kept open', async () => {
      const { dispatchId } = await harness.startSettledWorker('succeeded')
      await harness.call('orchestration.workerKeepOpen', {
        paneKey: harness.workerPaneKey,
        keep: true
      })

      // The agent process later exits on its own; the user's pane and scrollback remain.
      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string; reason?: string; archive: unknown }

      expect(receipt.state).toBe('retained')
      expect(receipt.reason).toBe('user_kept')
      expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(
        'retained'
      )
    })

    it.each(['transferred', 'external'] as const)(
      'does not release a %s resource on an exited process',
      async (ownershipState) => {
        const { dispatchId } = await harness.startSettledWorker('succeeded')
        const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
        harness.db.db
          .prepare('UPDATE worker_terminal_resources SET ownership_state = ? WHERE id = ?')
          .run(ownershipState, resource.id)

        harness.inspectProcessLiveness.mockResolvedValue('exited')
        const receipt = (await harness.call('orchestration.workerRelease', {
          dispatch: dispatchId
        })) as { state: string }

        expect(receipt.state).toBe('retained')
        const after = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
        expect(after?.ownership_state).toBe(ownershipState)
        expect(after?.release_state).not.toBe('released')
      }
    )

    it('records the archive as unavailable rather than retaining the pane forever', async () => {
      const { dispatchId } = await harness.startWorker()
      // Abandoned workers never reach `requested`, the only state that writes an archive.
      expect(harness.db.abandonWorkerDispatch(dispatchId, 'epoch_test').disposition).toBe(
        'abandoned'
      )
      expect(harness.db.getWorkerTerminalArchive(dispatchId)).toBeFalsy()

      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string; archive: { status: string | null } | null }

      expect(receipt.state).toBe('released')
      expect(receipt.archive?.status).toBe('unavailable')
    })

    it('exits retention after a recovery abandon even once the user retained it', async () => {
      const { dispatchId } = await harness.startWorker()
      harness.db.reconcileMissingWorkerTerminal(dispatchId, 'terminal gone')
      expect(harness.db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
      harness.inspectProcessLiveness.mockResolvedValue('exited')

      // retain deletes the archive and parks the row in `retained`: still no route back to `requested`.
      await harness.call('orchestration.workerRetain', { dispatch: dispatchId })
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string }

      expect(receipt.state).toBe('released')
    })

    it('still refuses when an archive names a different resource', async () => {
      const { dispatchId } = await harness.startWorker()
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      expect(harness.db.abandonWorkerDispatch(dispatchId, 'epoch_test').disposition).toBe(
        'abandoned'
      )
      harness.db.storeWorkerTerminalArchive({
        dispatchId,
        resourceId: `${resource.id}-other`,
        kind: 'terminal_tail',
        content: 'tail'
      })

      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string }

      expect(receipt.state).toBe('retained')
      expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe(
        'released'
      )
    })
  })

  const READY_WAIT = {
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  } satisfies RuntimeTerminalWait

  describe('Antigravity orchestration worker lifecycle', () => {
    const h = createOrchestrationWorkerReleaseHarness()

    afterEach(() => h.cleanup())

    it('owns the terminal immediately and delays prompt delivery until AGY is ready', async () => {
      h.setup()
      const readiness = h.deferred<RuntimeTerminalWait>()
      vi.spyOn(h.runtime, 'waitForTerminal').mockReturnValue(readiness.promise)

      const pending = h.startWorker({ agent: 'antigravity' })
      await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalled())

      expect(h.runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.objectContaining({ startupAgent: 'antigravity', surfaceOwner: false })
      )
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      expect(h.db.listWorkerTerminalResources({})[0]?.resource).toMatchObject({
        ownership_state: 'owned',
        terminal_handle: 'term_worker'
      })

      readiness.resolve(READY_WAIT)
      await expect(pending).resolves.toEqual(
        expect.objectContaining({ dispatchId: expect.any(String) })
      )
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    })

    it('stops only the owned AGY terminal', async () => {
      h.setup()
      const { dispatchId } = await h.startWorker({ agent: 'antigravity' })

      await expect(
        h.call('orchestration.workerStop', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
      expect(h.runtime.closeTerminal).toHaveBeenCalledOnce()
      expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    })

    it('releases an owned AGY terminal and recovers a transient stale endpoint', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('succeeded', {
        agent: 'antigravity'
      })
      vi.mocked(h.runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_pending', processAction: 'none' })
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'releasing'
      })

      await expect(reconcileRequestedWorkerTerminalReleases(h.runtime)).resolves.toMatchObject({
        attempted: 1,
        released: 1
      })
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        release_state: 'released'
      })
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(2)
      expect(h.runtime.closeTerminal).toHaveBeenNthCalledWith(2, 'term_worker')
    })

    it('fails closed on a stale AGY handle and releases it on a fresh retry', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('succeeded', {
        agent: 'antigravity'
      })
      vi.mocked(h.runtime.showTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_unknown' })
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'unknown'
      })

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
      expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    })
  })
}
