import { vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { RemovedSshTargetTombstone, SshTarget } from '../../shared/ssh-types'

export function createMockStore() {
  const targets: SshTarget[] = []
  const repos: Repo[] = []
  const folderWorkspaces: FolderWorkspace[] = []
  const projectGroups: { id: string; name: string; connectionId?: string | null }[] = []
  const leases: {
    state: 'attached' | 'detached' | 'terminated' | 'expired'
    ptyId?: string
    worktreeId?: string
    tabId?: string
    leafId?: string
    updatedAt?: number
  }[] = []
  let deletedAliases: string[] = []
  const removedTombstones: RemovedSshTargetTombstone[] = []
  const reassignments: { oldTargetId: string; newTargetId: string }[] = []
  let generationCounter = 0

  const dropTombstone = (oldTargetId: string) => {
    const kept = removedTombstones.filter((t) => t.oldTargetId !== oldTargetId)
    removedTombstones.length = 0
    removedTombstones.push(...kept)
  }

  return {
    allocateSshTargetGeneration: vi.fn(() => {
      generationCounter += 1
      return generationCounter
    }),
    getSshTargets: vi.fn(() => [...targets]),
    getSshTarget: vi.fn((id: string) => targets.find((t) => t.id === id)),
    getRepos: vi.fn(() => [...repos]),
    getProjectGroups: vi.fn(() => [...projectGroups]),
    getFolderWorkspaces: vi.fn(() => [...folderWorkspaces]),
    getSshRemotePtyLeases: vi.fn(() => [...leases]),
    inspectOrcadMigrationSourceDependencies: vi.fn(() => ({
      totalCount: 0,
      counts: {
        automation: 0,
        'automation-run': 0,
        'mobile-tab-selection': 0,
        'retired-worktree-name': 0,
        'saved-port-forward': 0,
        'sparse-preset': 0,
        'terminal-lease': 0,
        'terminal-recovery': 0,
        'ui-routing': 0,
        'workspace-lineage': 0,
        'workspace-session': 0,
        'worktree-lineage': 0,
        'worktree-metadata': 0
      }
    })),
    addSshTarget: vi.fn((target: SshTarget) => targets.push(target)),
    updateSshTarget: vi.fn((id: string, updates: Partial<Omit<SshTarget, 'id'>>) => {
      const target = targets.find((t) => t.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return { ...target }
    }),
    removeSshTarget: vi.fn((id: string) => {
      const idx = targets.findIndex((t) => t.id === id)
      if (idx !== -1) {
        targets.splice(idx, 1)
      }
    }),
    getDeletedSshConfigAliases: vi.fn(() => [...deletedAliases]),
    addDeletedSshConfigAlias: vi.fn((alias: string) => {
      if (!deletedAliases.includes(alias)) {
        deletedAliases.push(alias)
      }
    }),
    removeDeletedSshConfigAlias: vi.fn((alias: string) => {
      deletedAliases = deletedAliases.filter((entry) => entry !== alias)
    }),
    clearDeletedSshConfigAliases: vi.fn(() => {
      deletedAliases = []
    }),
    removedTombstones,
    reassignments,
    repos,
    projectGroups,
    folderWorkspaces,
    leases,
    getRemovedSshTargetTombstones: vi.fn(() => [...removedTombstones]),
    addRemovedSshTargetTombstone: vi.fn((tombstone: RemovedSshTargetTombstone) => {
      const filtered = removedTombstones.filter((t) => t.oldTargetId !== tombstone.oldTargetId)
      removedTombstones.length = 0
      removedTombstones.push(...filtered, tombstone)
    }),
    removeRemovedSshTargetTombstone: vi.fn(dropTombstone),
    // Nothing in this mock stores automations, so releasing always drops.
    releaseRemovedSshTargetTombstone: vi.fn(dropTombstone),
    reassignSshTargetId: vi.fn((oldTargetId: string, newTargetId: string) => {
      reassignments.push({ oldTargetId, newTargetId })
      // Pretend one repo referenced the old id.
      return ['repo-1']
    })
  }
}
