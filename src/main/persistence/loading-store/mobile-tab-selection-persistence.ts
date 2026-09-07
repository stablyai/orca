import type { PersistedMobileClientTabSelections } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type MobileTabSelectionRuntime = Pick<StoreRuntimeState, 'state'>

const mobileTabSelectionPersistenceContext = Symbol('MobileTabSelectionPersistence')
type MobileTabSelectionPersistenceContext = {
  runtime: MobileTabSelectionRuntime
  scheduling: WriteSchedulingOperations
}

export class MobileTabSelectionPersistence {
  readonly [mobileTabSelectionPersistenceContext]: MobileTabSelectionPersistenceContext

  constructor(runtime: MobileTabSelectionRuntime, scheduling: WriteSchedulingOperations) {
    this[mobileTabSelectionPersistenceContext] = { runtime, scheduling }
  }

  getMobileClientTabSelections(): PersistedMobileClientTabSelections {
    return (
      this[mobileTabSelectionPersistenceContext].runtime.state
        .mobileClientTabSelectionsByDeviceId ?? {}
    )
  }

  setMobileClientTabSelections(next: PersistedMobileClientTabSelections): void {
    this[mobileTabSelectionPersistenceContext].runtime.state.mobileClientTabSelectionsByDeviceId =
      next
    scheduleSave(this[mobileTabSelectionPersistenceContext].scheduling)
  }
}

export function installMobileTabSelectionPersistenceContext(
  target: object,
  source: MobileTabSelectionPersistence
): void {
  Object.defineProperty(target, mobileTabSelectionPersistenceContext, {
    value: source[mobileTabSelectionPersistenceContext]
  })
}
