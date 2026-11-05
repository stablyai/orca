import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

import { registerBoundPty } from '../../../../bind-first-pane.test-fixture'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

it.each(['local', 'ssh'])(
  'a handle-addressed phone Keep open fences %s worker release',
  async (host) => {
    if (host === 'ssh') {
      vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
        handle === 'term_worker'
          ? ({
              terminalHandle: handle,
              paneKey: h.workerPaneKey,
              processIncarnation: 'runtime_test:term_worker:1',
              hostScope: { kind: 'ssh', targetId: 'ssh-1' }
            } as never)
          : null
      )
    }
    const worker = await h.startSettledWorker()
    expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.host_scope).toContain(host)
    h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
    registerBoundPty(h.runtime, 'pty-worker', 'repo::worktree', null, {
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
    await expect(
      h.call('orchestration.workerKeepOpen', { terminal: 'term_worker', keep: true })
    ).resolves.toEqual({ autoClose: { kept: true } })
    await expect(
      h.call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_kept' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  }
)

it('an unknown handle does not fence another worker or access the database', async () => {
  const worker = await h.startSettledWorker()
  h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  registerBoundPty(h.runtime, 'pty-worker', 'repo::worktree', null, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
  const db = vi.spyOn(h.runtime, 'getOrchestrationDb')
  await expect(
    h.call('orchestration.workerKeepOpen', { terminal: 'term_missing', keep: true })
  ).resolves.toEqual({ autoClose: null })
  expect(db).not.toHaveBeenCalled()
  expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe('owned')
  await expect(
    h.call('orchestration.workerRelease', { dispatch: worker.dispatchId })
  ).resolves.toMatchObject({ state: 'released' })
})

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
