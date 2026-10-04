import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  WorktreeMetaPreconditionError,
  updateRuntimeManagedWorktreeMetadata
} from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('writes metadata through the resolved worktree execution host', async () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:build-box',
      path: '/workspace/app',
      instanceId: 'instance-1'
    } as unknown as ResolvedWorktree
    const setWorktreeMeta = vi.fn()
    const setWorktreeMetaForHost = vi.fn()
    const store = { setWorktreeMeta, setWorktreeMetaForHost } as unknown as RuntimeStore
    const ports = {
      resolveWorktree: vi.fn(async () => worktree),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => worktree as unknown as Worktree)
    }

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { comment: 'remote row only' },
      store,
      ports
    })

    expect(setWorktreeMetaForHost).toHaveBeenCalledWith(worktree.id, 'ssh:build-box', {
      comment: 'remote row only'
    })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('checks the precondition after resolving and refuses the write when it fails', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update reads only id and repoId off the resolved row.
    const worktree = { id: 'repo-1::/workspace/app', repoId: 'repo-1' } as ResolvedWorktree
    let stored: Pick<WorktreeMeta, 'snooze'> = { snooze: { snoozedAt: 1, wakeAt: 2 } }
    const setWorktreeMeta = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused precondition reaches only getWorktreeMeta; setWorktreeMeta is the spy that proves no write.
    const store = { setWorktreeMeta, getWorktreeMeta: () => stored } as unknown as RuntimeStore
    const ports = {
      // The user re-snoozes while the runtime resolves the selector.
      resolveWorktree: vi.fn(async () => {
        stored = { snooze: { snoozedAt: 3, wakeAt: 4 } }
        return worktree
      }),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => worktree)
    }

    await expect(
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { snooze: null },
        store,
        ports,
        precondition: (meta) => meta?.snooze?.snoozedAt === 1
      })
    ).rejects.toBeInstanceOf(WorktreeMetaPreconditionError)
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(ports.notifyChanged).not.toHaveBeenCalled()
  })
})
