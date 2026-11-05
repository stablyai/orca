import type { Store } from '../../../persistence/loading-store/store'
import { SurfaceAllocationRecovery } from '../../../workspace-surfaces/surface-allocation-recovery'
import { getLocalPtyProvider, onLocalPtyProviderChanged } from './registry'

const installed = new WeakMap<Store, () => void>()

/** Shared desktop/headless setup; renderer replacement cannot multiply recovery owners. */
export function installSurfaceAllocationRecovery(store: Store, ready?: Promise<void>): void {
  if (installed.has(store) || !store.onWorkspaceSurfaceCommitted) {
    return
  }
  let pending = false
  let releaseInterest: (() => void) | undefined
  const updateInterest = () => {
    releaseInterest?.()
    releaseInterest = pending
      ? getLocalPtyProvider().surfaceExecution?.retainRecoveryInterest?.()
      : undefined
  }
  const recovery = new SurfaceAllocationRecovery({
    pending: (hostId, value) => {
      if (hostId === 'local' && pending !== value) {
        pending = value
        updateInterest()
      }
    },
    scope: () => store.captureSurfaceExecutionScope(),
    provider: (hostId) => (hostId === 'local' ? getLocalPtyProvider() : undefined),
    execute: (command) => store.executeWorkspaceSurfaceCommand(command)
  })
  let disposed = false
  let providerDisposers: (() => void)[] = []
  let waking: Promise<void> | undefined
  const wake = () => {
    if (disposed || waking) {
      return
    }
    waking = recovery.wake('local').finally(() => {
      waking = undefined
    })
  }
  const rebind = () => {
    if (disposed) {
      return
    }
    for (const dispose of providerDisposers) {
      dispose()
    }
    updateInterest()
    const provider = getLocalPtyProvider()
    const executionWake = provider.surfaceExecution?.onWake?.((admission) => {
      if (admission) {
        try {
          recovery.wakeAllocation(admission)
        } catch {}
      } else {
        wake()
      }
    })
    providerDisposers = executionWake ? [executionWake] : []
    wake()
  }
  const commit = store.onWorkspaceSurfaceCommitted((result) => recovery.observe(result))
  const changed = onLocalPtyProviderChanged(rebind)
  const dispose = () => {
    if (disposed) {
      return
    }
    disposed = true
    recovery.dispose()
    releaseInterest?.()
    releaseInterest = undefined
    commit()
    changed()
    finalized()
    for (const stop of providerDisposers) {
      stop()
    }
    providerDisposers = []
    installed.delete(store)
  }
  const finalized = store.onProfilePersistenceFinalized(dispose)
  installed.set(store, dispose)
  rebind()
  if (ready) {
    void ready.then(rebind, () => {})
  }
}
