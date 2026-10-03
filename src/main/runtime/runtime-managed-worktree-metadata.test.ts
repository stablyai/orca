import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/worktree/types'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

function makeHarness() {
  const worktree = {
    id: 'repo-1::/workspace/app',
    repoId: 'repo-1',
    hostId: 'ssh:build-box',
    path: '/workspace/app',
    instanceId: 'instance-1'
  } as unknown as ResolvedWorktree
  const setWorktreeMetaForHost = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update path calls only these two store writers.
  const store = { setWorktreeMeta: vi.fn(), setWorktreeMetaForHost } as unknown as RuntimeStore
  const ports = {
    resolveWorktree: vi.fn(async () => worktree),
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn(),
    showWorktree: vi.fn(async () => worktree as unknown as Worktree)
  }
  return { worktree, store, ports, setWorktreeMetaForHost }
}

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('clears the worktree base ref when the wire sends null', async () => {
    const { worktree, store, ports, setWorktreeMetaForHost } = makeHarness()

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { baseRef: null },
      store,
      ports
    })

    const written = setWorktreeMetaForHost.mock.calls[0]?.[2]
    expect(Object.hasOwn(written, 'baseRef')).toBe(true)
    expect(written.baseRef).toBeUndefined()
  })

  it('leaves the base ref alone when the update omits it', async () => {
    const { worktree, store, ports, setWorktreeMetaForHost } = makeHarness()

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { comment: 'x', baseRef: undefined },
      store,
      ports
    })

    expect(setWorktreeMetaForHost).toHaveBeenCalledWith(worktree.id, 'ssh:build-box', {
      comment: 'x'
    })
  })

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
})
