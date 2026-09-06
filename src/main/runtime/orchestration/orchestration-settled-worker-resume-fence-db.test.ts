import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { planLegacyWorkerTerminalRecovery } from './orchestration-legacy-worker-terminal-recovery'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

const PANE_KEY = 'tab_worker:33333333-3333-4333-8333-333333333333'

describe('settled worker terminal resume fence rows', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createReadyWorker(): { db: OrchestrationDb; taskId: string; dispatchId: string } {
    const d = new OrchestrationDb(':memory:')
    db = d
    const task = d.createTask({ spec: 'settled worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    return { db: d, taskId: task.id, dispatchId: started.dispatch.id }
  }

  /** Asserts the `requested` arm so the resource row is non-null for the caller. */
  function requestRelease(d: OrchestrationDb, dispatchId: string): WorkerTerminalResourceRow {
    const requested = d.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected a release request, got ${requested.disposition}`)
    }
    return requested.resource
  }

  function settle(d: OrchestrationDb, taskId: string, dispatchId: string): void {
    expect(
      d.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'worker succeeded'
      }).action
    ).toBe('settled')
  }

  it('keeps a settled-but-unreleased worker terminal in the recovery rows', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)

    expect(d.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({
        dispatch_id: dispatchId,
        worker_state: 'succeeded',
        assignee_pane_key: PANE_KEY
      })
    ])
  })

  // A settled worker owns no live process, so it must only fence — never be offered for adoption.
  it('plans a settled pane as a fence with no adoption candidate', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)

    const plan = planLegacyWorkerTerminalRecovery(d.listLegacyWorkerTerminalRecoveryRows())

    expect(plan.blockedPanes).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, settled: true })
    ])
    expect(plan.candidates).toEqual([])
    expect(plan.ambiguousDispatchIds).toEqual([])
  })

  // `release_unknown` is the ticket's own repro: release could not be proven, the pane keeps a
  // resumable provider session, and dropping it here would re-open the auto-resume.
  it('keeps a settled worker terminal whose release could not be proven', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    const resource = requestRelease(d, dispatchId)
    expect(
      d.markWorkerTerminalReleaseUnknown(resource.id, 'terminal no longer resolves').release_state
    ).toBe('unknown')

    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({ dispatch_id: dispatchId, assignee_pane_key: PANE_KEY })
    ])
  })

  it('drops a settled worker terminal once its resource is released', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    const resource = requestRelease(d, dispatchId)
    expect(d.settleWorkerTerminalRelease(resource.id).release_state).toBe('released')

    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
  })

  it('drops a settled worker terminal the user chose to retain', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    d.retainWorkerTerminalResource(dispatchId)
    settle(d, taskId, dispatchId)

    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
  })

  it('drops a settled worker terminal the user took over', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    expect(d.markWorkerTerminalUserOwned(PANE_KEY)).toBe(1)

    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
  })
})
