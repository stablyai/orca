import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'

const SAVE_DEBOUNCE_MS = 1_000
const SAVE_MAX_WAIT_MS = 5_000

type WriteSchedulingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'dirtyProfileStateDomains'
  | 'firstPendingSaveAt'
  | 'pendingWrite'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
>

const writeSchedulingOperationsContext = Symbol('WriteSchedulingOperations')
type WriteSchedulingOperationsContext = {
  runtime: WriteSchedulingOperationsRuntime
  writes: PrimaryStateWriteOperations
}

export class WriteSchedulingOperations {
  readonly [writeSchedulingOperationsContext]: WriteSchedulingOperationsContext

  constructor(runtime: WriteSchedulingOperationsRuntime, writes: PrimaryStateWriteOperations) {
    this[writeSchedulingOperationsContext] = { runtime, writes }
  }

  async waitForPendingWrite(): Promise<void> {
    const { runtime } = this[writeSchedulingOperationsContext]
    await Promise.all([runtime.pendingWrite, runtime.activeViewPreference.waitForPendingWrite()])
  }
}

export function scheduleSave(
  owner: WriteSchedulingOperations,
  dirtyDomains?: readonly string[]
): void {
  const { runtime, writes } = owner[writeSchedulingOperationsContext]
  runtime.automationListProjectionCache = null
  const trackedDomains = runtime.dirtyProfileStateDomains
  if (dirtyDomains === undefined) {
    runtime.dirtyProfileStateDomains = null
  } else if (trackedDomains !== null) {
    for (const domain of dirtyDomains) {
      trackedDomains.add(domain)
    }
  }
  // A timer admitted after the final snapshot could outlive the awaited shutdown work.
  if (runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    return
  }
  runtime.writeGeneration += 1
  if (runtime.writesFrozen) {
    return
  }
  const now = Date.now()
  runtime.firstPendingSaveAt ??= now
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
  }
  const untilMaxWait = Math.max(0, runtime.firstPendingSaveAt + SAVE_MAX_WAIT_MS - now)
  const delay = Math.min(SAVE_DEBOUNCE_MS, untilMaxWait)
  runtime.writeTimer = setTimeout(() => {
    runtime.writeTimer = null
    runtime.firstPendingSaveAt = null
    void enqueueWrite(writes, { skipIfClean: true }).catch(() => {})
  }, delay)
}

export function installWriteSchedulingOperationsContext(
  target: WriteSchedulingOperations,
  source: WriteSchedulingOperations
): void {
  Object.defineProperty(target, writeSchedulingOperationsContext, {
    value: source[writeSchedulingOperationsContext]
  })
}
