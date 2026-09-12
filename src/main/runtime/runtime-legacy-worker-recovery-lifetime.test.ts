import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type { LegacyWorkerRecoveryPorts } from './runtime-legacy-worker-terminal-recovery-types'

function setup() {
  const ports = {
    preparePlan: vi.fn(() => ({ candidates: [], ambiguousDispatchIds: [] })),
    persist: vi.fn(async () => new Set<string>()),
    updateRetry: vi.fn(),
    reconcileRequestedReleases: vi.fn(async () => {}),
    reconcile: vi.fn()
  }
  const controller = new RuntimeLegacyWorkerTerminalRecoveryController(
    ports as unknown as LegacyWorkerRecoveryPorts
  )
  return { controller, ports }
}
afterEach(() => vi.useRealTimers())

it('cancels both local and SSH retry timers and refuses later recovery work', async () => {
  vi.useFakeTimers()
  const { controller, ports } = setup()
  const plan = {
    ambiguousDispatchIds: [],
    candidates: [
      { ptyId: 'local-pty', dispatchId: 'local-dispatch' },
      { ptyId: 'ssh:host@@remote-pty', dispatchId: 'remote-dispatch' }
    ]
  } as unknown as Parameters<typeof controller.updateRetry>[0]
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
      new Promise<void>((resolve) => {
        finish = resolve
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
