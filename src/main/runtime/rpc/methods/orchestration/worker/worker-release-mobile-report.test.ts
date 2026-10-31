import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import { sendTerminalStreamInput } from '../../terminal/terminal-input-delivery'
import { eraseRpcMethods, isStreamingMethod, type RpcMethod } from '../../../core'
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

it.each(['unary', 'stream'])('mobile %s bytes do no orchestration database work', async (lane) => {
  const worker = await h.startSettledWorker()
  const runtime = h.runtime
  runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  registerBoundPty(runtime, 'pty-worker', 'repo::worktree', null, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    incarnationId: 'runtime_test:term_worker:1'
  })
  const write = vi.fn(() => true)
  runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
  const commit = vi.fn(async () => {})
  vi.spyOn(runtime, 'beginMobileInputFloor').mockReturnValue({ commit, rollback: vi.fn() })
  const dbAccess = vi.spyOn(runtime, 'getOrchestrationDb')
  const prepare = vi.spyOn(h.db.db, 'prepare')
  const exec = vi.spyOn(h.db.db, 'exec')
  const params = {
    terminal: 'term_worker',
    text: 'x',
    client: { id: 'phone', type: 'mobile' as const }
  }
  if (lane === 'stream') {
    await expect(sendTerminalStreamInput(runtime, { ...params, isMobile: true })).resolves.toBe(
      'delivered'
    )
  } else {
    const method = eraseRpcMethods(TERMINAL_SEND_METHODS).find(
      (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
    )!
    await expect(
      method.handler(method.params!.parse(params) as never, { runtime } as never)
    ).resolves.toMatchObject({ send: { accepted: true } })
  }
  expect(write).toHaveBeenCalledWith('pty-worker', 'x', 'driving')
  expect(commit).toHaveBeenCalledTimes(1)
  expect(dbAccess).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
  expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe('owned')
})

it('Keep open and the countdown are reachable from a mobile-scoped device token', async () => {
  // An older phone's typing report must keep resolving too, or it would surface errors.
  const { MOBILE_RPC_METHOD_ALLOWLIST } =
    await import('../../../../runtime-rpc/runtime-rpc-mobile-method-allowlist')
  for (const method of [
    'orchestration.workerAutoClose',
    'orchestration.workerKeepOpen',
    'orchestration.workerTerminalUserInput'
  ]) {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method)).toBe(true)
  }
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
