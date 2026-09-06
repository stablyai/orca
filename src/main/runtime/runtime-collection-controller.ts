import type { Collection } from '../../shared/collection-types'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeCollectionDependencies = {
  getStore: () => RuntimeStore | null
  notifyReposChanged: () => void
}

export class RuntimeCollectionController {
  constructor(private readonly deps: RuntimeCollectionDependencies) {}

  listCollections(): Collection[] {
    return this.deps.getStore()?.getCollections?.() ?? []
  }

  async createCollection(input: { name: string; color?: string | null }): Promise<Collection> {
    const store = this.deps.getStore()
    if (!store?.createCollection) {
      throw new Error('runtime_unavailable')
    }
    const collection = store.createCollection(input)
    this.deps.notifyReposChanged()
    return collection
  }

  async updateCollection(
    collectionId: string,
    updates: Partial<Pick<Collection, 'name' | 'isCollapsed' | 'order' | 'color'>>
  ): Promise<Collection | null> {
    const store = this.deps.getStore()
    if (!store?.updateCollection) {
      throw new Error('runtime_unavailable')
    }
    const updated = store.updateCollection(collectionId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteCollection(collectionId: string): Promise<{ deleted: boolean }> {
    const store = this.deps.getStore()
    if (!store?.deleteCollection) {
      throw new Error('runtime_unavailable')
    }
    const deleted = store.deleteCollection(collectionId)
    if (deleted) {
      this.deps.notifyReposChanged()
    }
    return { deleted }
  }
}
