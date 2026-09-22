import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_PATH } from '../../../../orca-runtime-test-fixtures.spec'
import '../../../../orca-runtime-test-lifecycle.spec'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

class SetupGateRuntime extends OrcaRuntimeService {
  prepareSetup(ptyId: string): void {
    this.setupCompletionTokenByPtyId.set(ptyId, 'setup-gate-token')
  }

  waiterCount(handle: string): number {
    return this.terminalWaiters.get(handle)?.size ?? 0
  }
}

const setup: WorkerSetupReceipt = {
  requested: 'run',
  effective: 'run',
  source: 'orchestration_default',
  hookFound: true,
  startupPolicy: 'wait-for-setup',
  state: 'running'
}

async function createSetupRuntime() {
  const runtime = new SetupGateRuntime(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-setup-gate' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
  runtime.prepareSetup('pty-setup-gate')
  const unsubscribe = vi.fn()
  const subscribe = runtime.subscribeToTerminalData.bind(runtime)
  vi.spyOn(runtime, 'subscribeToTerminalData').mockImplementation((ptyId, listener) => {
    const dispose = subscribe(ptyId, listener)
    return () => {
      unsubscribe()
      dispose()
    }
  })
  const effects: WorkerEffect[] = [{ kind: 'setup', terminalId: handle }]
  return { runtime, handle, effects, unsubscribe }
}

describe('structured worker setup gate observer lifetime', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('releases setup subscriptions and exit waiters after repeated timeouts', async () => {
    const { runtime, handle, effects, unsubscribe } = await createSetupRuntime()
    vi.useFakeTimers()
    try {
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const waiting = awaitStructuredWorkerSetupGate({ runtime, setup, effects, timeoutMs: 10 })
        await vi.advanceTimersByTimeAsync(10)
        await expect(waiting).resolves.toEqual({ satisfied: false, status: 'timeout' })
      }
      expect(runtime.waiterCount(handle)).toBe(0)
      expect(unsubscribe).toHaveBeenCalledTimes(40)
      expect(effects).toEqual([{ kind: 'setup', terminalId: handle }])
      expect(vi.getTimerCount()).toBe(0)
      await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ status: 'running' })
    } finally {
      runtime.onPtyExit('pty-setup-gate', 0)
    }
  })

  it.each([0, 17])('clears the deadline after setup exits with code %s', async (exitCode) => {
    const { runtime, handle, effects, unsubscribe } = await createSetupRuntime()
    vi.useFakeTimers()
    const waiting = awaitStructuredWorkerSetupGate({ runtime, setup, effects, timeoutMs: 10 })
    runtime.onPtyData(
      'pty-setup-gate',
      `__ORCA_SETUP_COMPLETE__:setup-gate-token:${exitCode}\r\n`,
      100
    )
    await expect(waiting).resolves.toEqual({ satisfied: exitCode === 0, status: 'exited' })
    expect(runtime.waiterCount(handle)).toBe(0)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    runtime.onPtyExit('pty-setup-gate', 0)
  })

  it('preserves lost-observation evidence when the runtime wait rejects', async () => {
    const effects: WorkerEffect[] = [{ kind: 'setup', terminalId: 'term-gone' }]
    const runtime = {
      waitForSetupTerminalCompletion: vi.fn().mockRejectedValue(new Error('terminal_handle_stale'))
    }
    vi.useFakeTimers()
    await expect(
      awaitStructuredWorkerSetupGate({ runtime, setup, effects, timeoutMs: 10 })
    ).resolves.toBeNull()
    expect(effects).toContainEqual({
      kind: 'setup',
      action: 'wait_unevaluated',
      state: 'terminal_handle_stale'
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
