import type { SparsePreset } from '../../../shared/worktree/create-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type SparsePresetRuntime = Pick<StoreRuntimeState, 'state'>

const sparsePresetPersistenceContext = Symbol('SparsePresetPersistence')
type SparsePresetPersistenceContext = {
  runtime: SparsePresetRuntime
  scheduling: WriteSchedulingOperations
}

export class SparsePresetPersistence {
  readonly [sparsePresetPersistenceContext]: SparsePresetPersistenceContext

  constructor(runtime: SparsePresetRuntime, scheduling: WriteSchedulingOperations) {
    this[sparsePresetPersistenceContext] = { runtime, scheduling }
  }

  getSparsePresets(repoId: string): SparsePreset[] {
    return [
      ...(this[sparsePresetPersistenceContext].runtime.state.sparsePresetsByRepo[repoId] ?? [])
    ].sort((left, right) => left.name.localeCompare(right.name))
  }

  saveSparsePreset(preset: SparsePreset): SparsePreset {
    const existing =
      this[sparsePresetPersistenceContext].runtime.state.sparsePresetsByRepo[preset.repoId] ?? []
    const index = existing.findIndex((entry) => entry.id === preset.id)
    this[sparsePresetPersistenceContext].runtime.state.sparsePresetsByRepo[preset.repoId] =
      index === -1
        ? [...existing, preset]
        : existing.map((entry, entryIndex) => (entryIndex === index ? preset : entry))
    scheduleSave(this[sparsePresetPersistenceContext].scheduling)
    return preset
  }

  removeSparsePreset(repoId: string, presetId: string): void {
    const existing =
      this[sparsePresetPersistenceContext].runtime.state.sparsePresetsByRepo[repoId] ?? []
    this[sparsePresetPersistenceContext].runtime.state.sparsePresetsByRepo[repoId] =
      existing.filter((entry) => entry.id !== presetId)
    scheduleSave(this[sparsePresetPersistenceContext].scheduling)
  }
}

export function installSparsePresetPersistenceContext(
  target: object,
  source: SparsePresetPersistence
): void {
  Object.defineProperty(target, sparsePresetPersistenceContext, {
    value: source[sparsePresetPersistenceContext]
  })
}
