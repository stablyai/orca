import type { TestStore } from './worktrees-test-ipc-surface'

export function configureWorktreeMetadataMutationStoreMocks(store: TestStore): void {
  store.updateExistingWorktreeMeta.mockReset()
  store.updateExistingWorktreeMetaBatch.mockReset()
  // Payload tests use write spies; SQLite producer tests exercise admission itself.
  store.updateExistingWorktreeMeta.mockImplementation((id, patch, expectation) =>
    expectation?.executionHostId
      ? store.setWorktreeMetaForHost(id, expectation.executionHostId, patch)
      : store.setWorktreeMeta(id, patch)
  )
  store.updateExistingWorktreeMetaBatch.mockImplementation((updates) =>
    updates.map((update) => {
      store.updateExistingWorktreeMeta(update.worktreeId, update.updates)
      return update.worktreeId
    })
  )
}
