import type { TestStore } from './worktrees-test-ipc-surface'

export function configureMetadataPruningStoreMocks(
  store: TestStore,
  expectedSettings: unknown
): void {
  store.captureNativeLocalWorktreeMetadataScanExpectation.mockImplementation(
    (...args: unknown[]) => {
      const repo = args[0] as {
        id: string
        path: string
        connectionId?: string | null
        executionHostId?: string | null
        kind?: string
      }
      return {
        repo: {
          id: repo.id,
          path: repo.path,
          connectionId: repo.connectionId,
          executionHostId: repo.executionHostId,
          kind: repo.kind === 'folder' ? 'folder' : 'git',
          expectedRepo: repo
        },
        routing: {
          expectedProject: undefined,
          expectedProjectUpdatedAt: undefined,
          expectedSettings
        },
        metadata: []
      }
    }
  )
  store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([])
}
