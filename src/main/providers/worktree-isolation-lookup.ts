import type { Store } from '../persistence'
import type { WorktreeIsolation, WorktreeMeta } from '../../shared/types'

type WorktreeIsolationStore = Pick<Store, 'getWorktreeMeta'>

export class WorktreeIsolationLookup {
  private store: WorktreeIsolationStore

  constructor(store: WorktreeIsolationStore) {
    this.store = store
  }

  getIsolation(worktreeId: string | null | undefined): WorktreeIsolation {
    if (!worktreeId) {
      return 'host'
    }
    return normalizeIsolation(this.store.getWorktreeMeta(worktreeId))
  }
}

function normalizeIsolation(meta: WorktreeMeta | undefined): WorktreeIsolation {
  return meta?.isolation === 'docker' ? 'docker' : 'host'
}
