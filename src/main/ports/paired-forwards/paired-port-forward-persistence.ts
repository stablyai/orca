import type { PairedServerSavedPortForwards } from '../../../shared/remote-runtime/host-catalog/paired-server-saved-port-forwards'
import type { StoreRuntimeState } from '../../persistence/loading-store/store-runtime-state'
import {
  scheduleSave,
  type WriteSchedulingOperations
} from '../../persistence/loading-store/profile-writing/write-scheduling'

type PairedPortForwardRuntime = Pick<StoreRuntimeState, 'state'>

const pairedPortForwardPersistenceContext = Symbol('PairedPortForwardPersistence')
type PairedPortForwardPersistenceContext = {
  runtime: PairedPortForwardRuntime
  scheduling: WriteSchedulingOperations
}

export class PairedPortForwardPersistence {
  readonly [pairedPortForwardPersistenceContext]: PairedPortForwardPersistenceContext

  constructor(runtime: PairedPortForwardRuntime, scheduling: WriteSchedulingOperations) {
    this[pairedPortForwardPersistenceContext] = { runtime, scheduling }
  }

  /** As saved; read each record through readPairedServerSavedPortForwards. */
  getPairedPortForwards(): Readonly<Record<string, unknown>> {
    return this[pairedPortForwardPersistenceContext].runtime.state.pairedPortForwards ?? {}
  }

  /** Null forgets the server. Saves only on change. */
  setPairedPortForwards(environmentId: string, record: PairedServerSavedPortForwards | null): void {
    const { runtime, scheduling } = this[pairedPortForwardPersistenceContext]
    const { [environmentId]: previous, ...others } = runtime.state.pairedPortForwards ?? {}
    const unchanged =
      record === null
        ? previous === undefined
        : previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)
    if (unchanged) {
      return
    }
    runtime.state.pairedPortForwards = record ? { ...others, [environmentId]: record } : others
    scheduleSave(scheduling, ['pairedPortForwards'])
  }
}
