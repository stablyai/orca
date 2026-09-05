import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'

const SAVE_DEBOUNCE_MS = 1_000
const SAVE_MAX_WAIT_MS = 5_000

type WriteSchedulingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'firstPendingSaveAt'
  | 'lastWriteError'
  | 'pendingWrite'
  | 'quitFlushStarted'
  | 'writeGeneration'
  | 'writeTimer'
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
    await Promise.all([
      this[writeSchedulingOperationsContext].runtime.pendingWrite,
      this[writeSchedulingOperationsContext].runtime.activeViewPreference.waitForPendingWrite()
    ])
    const lastWriteError = this[writeSchedulingOperationsContext].runtime.lastWriteError
    if (lastWriteError != null) {
      throw lastWriteError
    }
  }
}

export function scheduleSave(owner: WriteSchedulingOperations): void {
  const runtime = owner[writeSchedulingOperationsContext].runtime
  runtime.automationListProjectionCache = null
  // Why: a successful quit snapshot is the last write; a failed one is not disk-consistent.
  if (runtime.quitFlushStarted && runtime.lastWriteError == null) {
    return
  }
  runtime.writeGeneration += 1
  if (runtime.quitFlushStarted) {
    if (runtime.writeTimer) {
      clearTimeout(runtime.writeTimer)
      runtime.writeTimer = null
    }
    runtime.firstPendingSaveAt = null
    void enqueueWrite(owner[writeSchedulingOperationsContext].writes).catch(() => {})
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
    void enqueueWrite(owner[writeSchedulingOperationsContext].writes).catch(() => {})
  }, delay)
}

export function installWriteSchedulingOperationsContext(
  target: object,
  source: WriteSchedulingOperations
): void {
  Object.defineProperty(target, writeSchedulingOperationsContext, {
    value: source[writeSchedulingOperationsContext]
  })
}
