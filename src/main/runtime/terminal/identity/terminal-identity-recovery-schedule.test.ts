import '../../orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'
import {
  identityFixture,
  identityGraph,
  watchIdentityFixture,
  LEAF,
  PANE
} from '../query/terminal-identity.test-fixture'
import {
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { OrchestrationDb } from '../../orchestration/db'
import type { DurableProfileStateMutation } from '../../../persistence/loading-store/store-runtime-state'

it('retires the real no-snapshot legacy rollback after persistence even when subsequent DB reconciliation fails', async () => {
  const run = async (captured: boolean) => {
    const db = new OrchestrationDb(':memory:')
    const harness = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
    const entered = deferred<void>()
    const release = deferred<void>()
    const durable = harness.runtimeStore.runDurableMutation.bind(harness.runtimeStore)
    const f = identityFixture(undefined, {
      ...harness.runtimeStore,
      runDurableMutation: async <T>(mutate: () => DurableProfileStateMutation<T>): Promise<T> => {
        const result = await durable(mutate)
        entered.resolve()
        await release.promise
        return result
      }
    })
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'Retained worker' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_legacy',
      paneKey: PANE,
      processIncarnation: 'pty-legacy:old',
      worktreeId: TEST_WORKTREE_ID,
      effects: [],
      setupState: 'not_configured',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatch.id)
    db.db.prepare('UPDATE dispatch_contexts SET contract_version = 0 WHERE id = ?').run(dispatch.id)
    db.db.exec(
      "CREATE TRIGGER fail_missing_reconcile BEFORE UPDATE ON worker_dispatches BEGIN SELECT RAISE(ABORT, 'reconcile_failed'); END"
    )
    f.runtime.setOrchestrationDb(db)
    f.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    f.runtime.registerPty('pty-legacy', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'old',
      terminalHandle: 'term_legacy'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, identityGraph('pty-legacy'))
    const removed = vi.spyOn(f.owner.source, 'removeLeaf')
    const watched = watchIdentityFixture(f, captured)
    const ptyPane = () => watched.pane(PANE)?.paneKey ?? null
    try {
      expect(watched.pane(PANE)?.ptyId).toBe('pty-legacy')
      expect(f.owner.hasMobileSnapshot(TEST_WORKTREE_ID)).toBe(false)
      const recovering = f.runtime.reconcileLegacyWorkerTerminals()
      await Promise.race([
        entered.promise,
        recovering.then(() => {
          throw new Error('Recovery finished before durable return')
        })
      ])
      expect(watched.pane(PANE)?.ptyId).toBe('pty-legacy')
      expect(removed).not.toHaveBeenCalled()
      const captures = watched.acquisition.mock.calls.length
      release.resolve()
      await expect(recovering).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: [dispatch.id]
      })
      expect(removed).toHaveBeenCalledExactlyOnceWith(`tab-original::${LEAF}`)
      expect(f.owner.getLeavesForPty('pty-legacy')).toEqual([])
      expect(f.owner.ptysById.get('pty-legacy')?.paneKey).toBeNull()
      expect(watched.pane(PANE)).toBeNull()
      expect(watched.acquisition.mock.calls.length).toBeGreaterThan(captures)
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
      expect(f.owner.hasMobileSnapshot(TEST_WORKTREE_ID)).toBe(false)
      return { state: f.state(), removed: removed.mock.calls, pane: ptyPane() }
    } finally {
      release.resolve()
      await f.runtime.stopLegacyWorkerTerminalRecovery()
      watched.close()
      db.close()
    }
  }
  expect(await run(true)).toEqual(await run(false))
})
