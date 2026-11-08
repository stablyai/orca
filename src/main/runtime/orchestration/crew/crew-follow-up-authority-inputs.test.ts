import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'

import { OrchestrationError } from '../orchestration-error'

import { meterCrewSql } from './crew-recipient-sql.test-fixture'
import { CrewReadModel } from './crew-read-model'
import { watchCrewRuntimeSources } from './crew-runtime-watch'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/nested-worker-depth'
import { fixture as settingsFixture } from '../../../persistence/loading-store/profile-state-delayed-authority-fixture'

it('recaptures contextual depth through the actual settings writer/topology callback, with retry, equality and disposal', async () => {
  const f = fixture()
  const { store } = await settingsFixture(undefined, { nestedWorkerMaxDepth: 3 })
  const caller = f.assign('term_worker')
  const started = f.db.createStartingWorkerDispatch({
    creator: { kind: 'terminal', handle: 'term_worker', paneKey: f.handles.get('term_worker') },
    maxDepth: 3,
    taskRunId: f.run.id,
    taskSpec: 'real helper',
    startOptions: {}
  })
  f.db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_helper',
    paneKey: f.handles.get('term_helper')!,
    processIncarnation: 'process:term_helper',
    worktreeId: 'test',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  f.db.markWorkerDispatchReady(started.dispatch.id)
  f.db.settleWorkerReport({
    taskId: started.task.id,
    dispatchId: started.dispatch.id,
    outcome: 'succeeded',
    result: 'done'
  })
  f.deps.maxDepth = () => resolveNestedWorkerMaxDepth(store.getSettings())
  const model = new CrewReadModel(
    () => f.deps,
    (wake) =>
      watchCrewRuntimeSources(
        {
          store,
          watchChanges: f.db.crewChanges.subscribe,
          watchTransitions: () => () => {},
          watchClient: () => () => {}
        },
        wake
      )
  )
  const wake = vi.fn()
  const stop = model.subscribe(wake)
  const action = () =>
    model
      .read('term_worker')
      .sections.managing.find(
        (row) => row.openTarget?.kind === 'terminal' && row.openTarget.handle === 'term_helper'
      )
  const meter = meterCrewSql(f.db.db)
  try {
    const first = action()
    expect(first?.sendAddress).toBe(`dispatch:${started.dispatch.id}`)
    store.updateSettings({ nestedWorkerMaxDepth: 1 }, { notifyListeners: true })
    expect(wake).toHaveBeenCalled()
    const lower = action()
    expect(lower?.partyKey).toBe(first?.partyKey)
    expect(lower?.openTarget).toEqual(first?.openTarget)
    expect(lower?.sendAddress).toBe('term_helper')
    store.updateSettings({ nestedWorkerMaxDepth: 3 }, { notifyListeners: true })
    const failure = new OrchestrationError('task_not_found', 'reader failure is not denial')
    // Direct ownership requires no predecessor read; the holder/caller Dispatch read is still required.
    meter.control.before = (sql) => {
      if (sql.startsWith('SELECT id, run_id, creator_dispatch_id')) {
        throw failure
      }
    }
    expect(action).toThrow(failure)
    meter.control.before = undefined
    expect(action()).toEqual(first)
    stop()
    f.db.completeDispatch(caller.id)
    const calls = wake.mock.calls.length
    await Promise.resolve()
    expect(wake).toHaveBeenCalledTimes(calls)
    const again = model.subscribe(wake)
    try {
      expect(action()?.sendAddress).not.toBe(`dispatch:${started.dispatch.id}`)
    } finally {
      again()
    }
  } finally {
    stop()
    meter.restore()
  }
})
