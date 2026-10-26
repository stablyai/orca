import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../shared/repo-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'

type RuntimeLocalWorktreeCreateArgs = Parameters<typeof createRuntimeLocalManagedWorktree>[0]
type RuntimeLocalWorktreeCreateRemote = {
  remoteBase: RuntimeLocalWorktreeCreateArgs['resolveRemoteTrackingBase']
  hasRemoteRef: RuntimeLocalWorktreeCreateArgs['hasRemoteTrackingRef']
  refresh: RuntimeLocalWorktreeCreateArgs['refreshRemoteTrackingBase']
  fetch: RuntimeLocalWorktreeCreateArgs['fetchRemote']
}

export const WEB_SPARSE_PRESET: SparsePreset = {
  id: 'preset-web',
  repoId: 'repo-1',
  name: 'web',
  directories: ['apps/web', 'packages/ui'],
  createdAt: 0,
  updatedAt: 0
}

/** Runs the real runtime create against a fake store that records metadata writes. */
export function runtimeLocalWorktreeCreator({
  remote,
  writtenMeta,
  readSparsePresets
}: {
  remote: RuntimeLocalWorktreeCreateRemote
  writtenMeta: Partial<WorktreeMeta>[]
  readSparsePresets: (repoId: string) => SparsePreset[]
}) {
  return function createWorktree(
    request: Partial<RuntimeManagedWorktreeCreateArgs> = {},
    rearm: PreparationRearmHolder = { fire: () => {} },
    timing: WorktreeCreateTimingRecorder = createWorktreeCreateTimingRecorder(),
    repoOverrides: Partial<Repo> = {},
    autoRenameBranchFromWork = false
  ) {
    const store = {
      getSettings: () => ({
        workspaceDir: '/worktrees',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: '',
        autoRenameBranchFromWork
      }),
      setWorktreeMeta: (_target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
        writtenMeta.push(updates)
        return updates
      },
      getSparsePresets: (repoId: string): SparsePreset[] => readSparsePresets(repoId)
    }
    return createRuntimeLocalManagedWorktree({
      request: { repoSelector: 'repo-1', name: 'app', baseBranch: 'main', ...request },
      repo: {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 0,
        ...repoOverrides
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All store methods reached by this isolated create path are supplied above.
      store: store as Store,
      createdWithAgent: undefined,
      resolveRemoteTrackingBase: remote.remoteBase,
      hasRemoteTrackingRef: remote.hasRemoteRef,
      // vi.fn marks returned promises handled; a fresh promise exposes unawaited fetch rejection.
      refreshRemoteTrackingBase: async (...refreshArgs) => await remote.refresh(...refreshArgs),
      fetchRemote: async (...fetchArgs) => await remote.fetch(...fetchArgs),
      onWorktreeMetadataPersisted: () => undefined,
      rearm,
      timing
    })
  }
}
