import { afterEach, expect, it, vi } from 'vitest'
import { installOrcadOrchestrationRecovery } from './orcad-orchestration-recovery'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'

const lifetimes: OrcadRuntimeLifetime[] = []
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.stop()))
})
function setup() {
  const lifetime = new OrcadRuntimeLifetime(vi.fn())
  lifetimes.push(lifetime)
  const options = {
    lifetime,
    refreshAuthority: vi.fn(async () => {}),
    reconcileWorkers: vi.fn(async () => {}),
    onError: vi.fn()
  }
  return { ...options, recovery: installOrcadOrchestrationRecovery(options) }
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('defers early notifications and refreshes authority before adopting workers', async () => {
  const f = setup()
  f.recovery.notify()
  f.recovery.notify()
  await Promise.resolve()
  expect(f.refreshAuthority).not.toHaveBeenCalled()
  await f.recovery.start()
  expect(f.refreshAuthority).toHaveBeenCalledOnce()
  expect(f.reconcileWorkers).toHaveBeenCalledOnce()
  expect(f.refreshAuthority.mock.invocationCallOrder[0]).toBeLessThan(
    f.reconcileWorkers.mock.invocationCallOrder[0]
  )
})

it('fails startup without adopting workers when authority is unavailable', async () => {
  const f = setup()
  const error = new Error('terminal_liveness_unavailable')
  f.refreshAuthority.mockRejectedValue(error)
  await expect(f.recovery.start()).rejects.toBe(error)
  expect(f.reconcileWorkers).not.toHaveBeenCalled()
})

it('coalesces reconnect notifications and refreshes again before adopting after a transition', async () => {
  const f = setup()
  await f.recovery.start()
  const refresh = deferred()
  f.refreshAuthority.mockReturnValueOnce(refresh.promise)
  f.recovery.notify()
  await vi.waitFor(() => expect(f.refreshAuthority).toHaveBeenCalledTimes(2))
  f.recovery.notify()
  f.recovery.notify()
  refresh.resolve()
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(2))
  expect(f.refreshAuthority).toHaveBeenCalledTimes(3)
})

it('does not lose a reconnect that arrives while an earlier refresh fails', async () => {
  const f = setup()
  await f.recovery.start()
  const refresh = deferred()
  f.refreshAuthority.mockReturnValueOnce(refresh.promise)
  f.recovery.notify()
  await vi.waitFor(() => expect(f.refreshAuthority).toHaveBeenCalledTimes(2))
  f.recovery.notify()
  refresh.reject(new Error('old connection lost'))
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(2))
  expect(f.refreshAuthority).toHaveBeenCalledTimes(3)
  expect(f.onError).not.toHaveBeenCalled()
})

it('reports a background failure and can recover on a later notification', async () => {
  const f = setup()
  await f.recovery.start()
  const error = new Error('terminal_liveness_unavailable')
  f.refreshAuthority.mockRejectedValueOnce(error)
  f.recovery.notify()
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledExactlyOnceWith(error))
  expect(f.reconcileWorkers).toHaveBeenCalledOnce()
  f.recovery.notify()
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(2))
})

it('holds lifetime shutdown until pending refresh settles without adopting workers', async () => {
  const f = setup()
  await f.recovery.start()
  const refresh = deferred()
  f.refreshAuthority.mockReturnValueOnce(refresh.promise)
  f.recovery.notify()
  await vi.waitFor(() => expect(f.refreshAuthority).toHaveBeenCalledTimes(2))
  const stopped = vi.fn()
  const stopping = f.lifetime.stop().then(stopped)
  await Promise.resolve()
  expect(stopped).not.toHaveBeenCalled()
  f.recovery.notify()
  refresh.resolve()
  await stopping
  expect(f.reconcileWorkers).toHaveBeenCalledOnce()
  expect(f.refreshAuthority).toHaveBeenCalledTimes(2)
  await expect(f.recovery.start()).rejects.toThrow('recovery_stopped')
})

it('serializes a notification arriving during worker reconciliation', async () => {
  const f = setup()
  await f.recovery.start()
  const reconcile = deferred()
  f.reconcileWorkers.mockReturnValueOnce(reconcile.promise)
  f.recovery.notify()
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(2))
  f.recovery.notify()
  expect(f.refreshAuthority).toHaveBeenCalledTimes(2)
  reconcile.resolve()
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(3))
  expect(f.refreshAuthority).toHaveBeenCalledTimes(3)
})

it('retains a notification between the last recovery pass and promise cleanup', async () => {
  const f = setup()
  await f.recovery.start()
  f.reconcileWorkers.mockImplementationOnce(() =>
    Promise.resolve().then(() => {
      queueMicrotask(() => queueMicrotask(() => f.recovery.notify()))
    })
  )
  f.recovery.notify()
  await vi.waitFor(() => expect(f.reconcileWorkers).toHaveBeenCalledTimes(3))
  expect(f.refreshAuthority).toHaveBeenCalledTimes(3)
})
