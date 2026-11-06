import type { Collection } from '../../../shared/collection-types'
import {
  createCollection,
  getNextCollectionOrder,
  normalizeCollectionName,
  sortCollectionsByOrder
} from '../../../shared/collections'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'
import { pruneCollectionMemberships } from './worktree-collection-membership'

type CollectionOperationsRuntime = Pick<StoreRuntimeState, 'state'>

const collectionOperationsContext = Symbol('CollectionOperations')
type CollectionOperationsContext = {
  runtime: CollectionOperationsRuntime
  scheduling: WriteSchedulingOperations
}

/** Named, purely-visual sidebar sections grouping worktrees across repos. */
export class CollectionOperations {
  readonly [collectionOperationsContext]: CollectionOperationsContext

  constructor(runtime: CollectionOperationsRuntime, scheduling: WriteSchedulingOperations) {
    this[collectionOperationsContext] = { runtime, scheduling }
  }

  getCollections(): Collection[] {
    return sortCollectionsByOrder(this[collectionOperationsContext].runtime.state.collections ?? [])
  }

  createCollection(input: { name: string; color?: string | null }): Collection {
    const state = this[collectionOperationsContext].runtime.state
    const collection = createCollection({
      name: input.name,
      color: input.color ?? null,
      order: getNextCollectionOrder(state.collections ?? [])
    })
    state.collections = [...(state.collections ?? []), collection]
    scheduleSave(this[collectionOperationsContext].scheduling)
    return collection
  }

  updateCollection(
    collectionId: string,
    updates: Partial<Pick<Collection, 'name' | 'isCollapsed' | 'order' | 'color'>>
  ): Collection | null {
    const state = this[collectionOperationsContext].runtime.state
    const collection = (state.collections ?? []).find((entry) => entry.id === collectionId)
    if (!collection) {
      return null
    }
    if (updates.name !== undefined) {
      collection.name = normalizeCollectionName(updates.name, collection.name)
    }
    if (updates.isCollapsed !== undefined) {
      collection.isCollapsed = updates.isCollapsed
    }
    if (updates.order !== undefined && Number.isFinite(updates.order)) {
      collection.order = updates.order
    }
    if (updates.color !== undefined) {
      collection.color = typeof updates.color === 'string' ? updates.color : null
    }
    collection.updatedAt = Date.now()
    scheduleSave(this[collectionOperationsContext].scheduling)
    return collection
  }

  deleteCollection(collectionId: string): boolean {
    const state = this[collectionOperationsContext].runtime.state
    const before = state.collections?.length ?? 0
    state.collections = (state.collections ?? []).filter((entry) => entry.id !== collectionId)
    if ((state.collections?.length ?? 0) === before) {
      return false
    }
    // Why: purely-visual grouping — deleting a collection strips memberships, never worktrees.
    pruneCollectionMemberships(state)
    scheduleSave(this[collectionOperationsContext].scheduling)
    return true
  }
}
