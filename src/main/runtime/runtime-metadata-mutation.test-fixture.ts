import type { RuntimeStore } from './runtime-store-contract'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  WorktreeMetadataExpectation,
  ExistingWorktreeMetadataUpdate
} from '../persistence/loading-store/worktree-metadata-admission'

// Legacy runtime fixtures omit canonical tables; SQLite integration tests cover admission itself.
export const runtimeMetadataMutationFixture = {
  isCurrentWorktreeMetadata(
    this: RuntimeStore,
    id: string,
    expectation: WorktreeMetadataExpectation = {}
  ) {
    const meta = this.getWorktreeMeta(id)
    return Boolean(
      meta &&
      (expectation.instanceId === undefined ||
        meta.instanceId === undefined ||
        expectation.instanceId === meta.instanceId)
    )
  },
  updateExistingWorktreeMeta(
    this: RuntimeStore,
    id: string,
    updates: Partial<WorktreeMeta>,
    expectation: WorktreeMetadataExpectation = {}
  ) {
    if (!this.isCurrentWorktreeMetadata?.(id, expectation)) {
      return undefined
    }
    return expectation.executionHostId && this.setWorktreeMetaForHost
      ? this.setWorktreeMetaForHost(id, expectation.executionHostId, updates)
      : this.setWorktreeMeta(id, updates)
  },
  updateExistingWorktreeMetaBatch(
    this: RuntimeStore,
    updates: readonly ExistingWorktreeMetadataUpdate[]
  ) {
    return updates
      .filter((update) => this.updateExistingWorktreeMeta?.(update.worktreeId, update.updates))
      .map((update) => update.worktreeId)
  }
}
