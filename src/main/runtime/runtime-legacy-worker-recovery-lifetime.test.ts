import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type { LegacyWorkerRecoveryPorts } from './runtime-legacy-worker-terminal-recovery-types'
import type {
  LegacyWorkerTerminalRecoveryCandidate,
  LegacyWorkerTerminalRecoveryPlan
} from './orchestration/orchestration-legacy-worker-terminal-recovery'

function candidate(ptyId: string, dispatchId: string): LegacyWorkerTerminalRecoveryCandidate {
  return {
    dispatchId,
    dispatchStatus: 'dispatched',
    contractVersion: 1,
    taskId: 'task',
    worktreeId: 'worktree',
    terminalHandle: 'handle',
    paneKey: 'tab:leaf',
    tabId: 'tab',
    leafId: 'leaf',
    processIncarnation: `${ptyId}:incarnation`,
    ptyId,
    incarnationId: 'incarnation'
  }
}

function setup() {
  const ports = {
    preparePlan: vi.fn((): LegacyWorkerTerminalRecoveryPlan => ({
      candidates: [],
      ambiguousDispatchIds: []
    })),
    resolveWorkspace: vi.fn(async () => {
      throw new Error('unused')
    }),
    refreshInventory: vi.fn(async () => null),
    runMutation: <T>(_worktreeId: string, operation: () => Promise<T>) => operation(),
    getActivation: () => ({}),
    hasExactPersistedSurface: () => false,
    hasExactSurface: () => false,
    adopt: vi.fn(async () => {}),
    getRendererEpoch: () => 0,
    reveal: vi.fn(async () => null),
    onPtyExit: vi.fn(),
    persist: vi.fn(async (): Promise<ReadonlySet<string>> => new Set<string>()),
    rollback: vi.fn(),
    reconcileMissing: () => false,
    notifyResolution: vi.fn(),
    canRecoverPersistentLocalPtys: () => true,
    reconcileRequestedReleases: vi.fn(async (): Promise<unknown> => undefined),
    reconcile: vi.fn(async () => ({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })),
    updateRetry: vi.fn()
  } satisfies LegacyWorkerRecoveryPorts
  const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)
  return { controller, ports }
}
afterEach(() => vi.useRealTimers())

it('cancels both local and SSH retry timers and refuses later recovery work', async () => {
  vi.useFakeTimers()
  const { controller, ports } = setup()
  const plan: LegacyWorkerTerminalRecoveryPlan = {
    ambiguousDispatchIds: [],
    candidates: [
      candidate('local-pty', 'local-dispatch'),
      candidate('ssh:host@@remote-pty', 'remote-dispatch')
    ]
  }
  const deferred = new Set(['local-dispatch', 'remote-dispatch'])
  controller.updateRetry(plan, deferred, {})
  controller.updateRetry(plan, deferred, { connectionId: 'host' })
  expect(vi.getTimerCount()).toBe(2)
  await controller.stop()
  controller.updateRetry(plan, deferred, {})
  await vi.advanceTimersByTimeAsync(60_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(ports.reconcile).not.toHaveBeenCalled()
  await expect(controller.reconcile()).rejects.toThrow('recovery_stopped')
})

it('drains an active persistence pass but refuses a queued pass after shutdown', async () => {
  const { controller, ports } = setup()
  let finish!: (value: Set<string>) => void
  ports.persist.mockImplementationOnce(
    () =>
      new Promise<Set<string>>((resolve) => {
        finish = resolve
      })
  )
  const first = controller.reconcile()
  await vi.waitFor(() => expect(ports.persist).toHaveBeenCalledOnce())
  const queued = expect(controller.reconcile()).rejects.toThrow('recovery_stopped')
  const settled = vi.fn()
  const stopping = controller.stop().then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  finish(new Set())
  await Promise.all([first, queued, stopping])
  expect(ports.preparePlan).toHaveBeenCalledOnce()
  expect(ports.persist).toHaveBeenCalledOnce()
})

it('holds shutdown until requested-release reconciliation finishes', async () => {
  const { controller, ports } = setup()
  let finish!: () => void
  ports.reconcileRequestedReleases.mockImplementationOnce(
    () =>
      new Promise<unknown>((resolve) => {
        finish = () => resolve(undefined)
      })
  )
  const recovery = controller.reconcile()
  await vi.waitFor(() => expect(ports.reconcileRequestedReleases).toHaveBeenCalledOnce())
  const settled = vi.fn()
  const stopping = controller.stop().then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  finish()
  await Promise.all([recovery, stopping])
  expect(settled).toHaveBeenCalledOnce()
})
