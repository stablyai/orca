import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

import { registerBoundPty } from '../../../../../orca-runtime-tests/bind-first-pane.test-fixture'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

// Boot-wait Keep open must find custody written at terminal creation, or a later release closes a kept pane (#19337, #19608).
it('a phone Keep open during the boot wait keeps the pane and fences the later release', async () => {
  const gate = h.deferred<unknown>()
  vi.spyOn(h.runtime, 'waitForTerminal').mockReturnValue(gate.promise as never)
  const task = h.db.createTask({ spec: 'mid-boot phone takeover', runId: h.activeRunId })
  const start = h.call('orchestration.workerStart', {
    task: task.id,
    from: 'term_coord',
    agent: 'codex'
  })
  await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalled())
  const dispatchId = (
    h.db.db.prepare("SELECT dispatch_id FROM worker_dispatches WHERE state = 'starting'").get() as {
      dispatch_id: string
    }
  ).dispatch_id

  h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  registerBoundPty(h.runtime, 'pty-worker', 'repo::worktree', null, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
  await expect(
    h.call('orchestration.workerKeepOpen', { terminal: 'term_worker', keep: true })
  ).resolves.toEqual({ autoClose: { kept: true } })

  gate.resolve({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  await expect(start).resolves.toMatchObject({ state: 'ready' })

  h.settle(task.id, dispatchId, 'succeeded')
  await expect(
    h.call('orchestration.workerRelease', { dispatch: dispatchId })
  ).resolves.toMatchObject({ state: 'retained', reason: 'user_kept', processAction: 'none' })
  expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
})
