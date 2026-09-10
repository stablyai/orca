import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import { sendTerminalStreamInput } from '../../terminal/terminal-input-delivery'
import { isStreamingMethod, type RpcMethod } from '../../../core'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

it.each(['local', 'ssh'])(
  'a handle-addressed phone report fences %s worker release',
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
    h.runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
    await expect(
      h.call('orchestration.workerTerminalUserInput', { terminal: 'term_worker' })
    ).resolves.toEqual({ changed: 1 })
    expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe(
      'user_owned'
    )
    await expect(
      h.call('orchestration.workerTerminalUserInput', { terminal: 'term_worker' })
    ).resolves.toEqual({ changed: 0 })
    await expect(
      h.call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  }
)

it('an unknown handle does not fence another worker or access the database', async () => {
  const worker = await h.startSettledWorker()
  h.runtime.registerPreAllocatedHandleForPty('pty-worker', 'term_worker')
  h.runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
  const db = vi.spyOn(h.runtime, 'getOrchestrationDb')
  await expect(
    h.call('orchestration.workerTerminalUserInput', { terminal: 'term_missing' })
  ).resolves.toEqual({ changed: 0 })
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
  runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    incarnationId: 'runtime_test:term_worker:1'
  })
  const write = vi.fn(() => true)
  runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
  const commit = vi.fn(async () => {})
  vi.spyOn(runtime, 'beginMobileInputFloor').mockReturnValue({ commit, rollback: vi.fn() })
  const dbAccess = vi.spyOn(runtime, 'getOrchestrationDb')
  const takeover = vi.spyOn(h.db, 'markWorkerTerminalUserOwned')
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
    const method = TERMINAL_SEND_METHODS.find(
      (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
    )!
    await expect(
      method.handler(method.params!.parse(params) as never, { runtime } as never)
    ).resolves.toMatchObject({ send: { accepted: true } })
  }
  expect(write).toHaveBeenCalledWith('pty-worker', 'x')
  expect(commit).toHaveBeenCalledTimes(1)
  expect(dbAccess).not.toHaveBeenCalled()
  expect(takeover).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
  expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.ownership_state).toBe('owned')
})

it('the report is reachable from a mobile-scoped device token', async () => {
  // Why: mobile tokens are gated by an allowlist before dispatch. The phone reporter swallows a
  // refusal, so a missing entry silently reverts every phone to the unfenced behaviour.
  const { MOBILE_RPC_METHOD_ALLOWLIST } =
    await import('../../../../runtime-rpc/runtime-rpc-mobile-method-allowlist')
  expect(MOBILE_RPC_METHOD_ALLOWLIST.has('orchestration.workerTerminalUserInput')).toBe(true)
})

// Round-1 regression (#19337 review): a phone key landing inside the worker's boot wait used to
// find no `owned` row, report `changed: 0`, and still arm the client's 30 s gate — so the real
// takeover was suppressed and `worker-release` closed the pane. #19608 writes custody at terminal
// creation, so the boot-wait key itself takes the pane.
it('a phone report during the boot wait takes the pane and fences the later release', async () => {
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
  h.runtime.registerPty('pty-worker', 'repo::worktree', undefined, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
  await expect(
    h.call('orchestration.workerTerminalUserInput', { terminal: 'term_worker' })
  ).resolves.toEqual({ changed: 1 })

  gate.resolve({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  await expect(start).resolves.toMatchObject({ state: 'ready' })
  expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')

  h.settle(task.id, dispatchId, 'succeeded')
  await expect(
    h.call('orchestration.workerRelease', { dispatch: dispatchId })
  ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover', processAction: 'none' })
  expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
})
