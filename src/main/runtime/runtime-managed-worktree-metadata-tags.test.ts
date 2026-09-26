import { describe, expect, it, vi } from 'vitest'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

function setup(initialTags: string[]) {
  const metaById = new Map<string, Partial<WorktreeMeta>>([['repo::/wt', { tags: initialTags }]])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update reads and writes only these store members.
  const store = {
    getWorktreeMeta: (id: string) => metaById.get(id),
    getWorktreeMetaForHost: (id: string) => metaById.get(id),
    setWorktreeMeta: vi.fn(),
    setWorktreeMetaForHost: vi.fn((id: string, _host: string, updates: Partial<WorktreeMeta>) => {
      metaById.set(id, { ...metaById.get(id), ...updates })
    })
  } as unknown as RuntimeStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update reads only id, repoId, and hostId.
  const worktree = { id: 'repo::/wt', repoId: 'repo', hostId: 'local' } as ResolvedWorktree
  const ports = {
    resolveWorktree: async () => worktree,
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers only await the returned row.
    showWorktree: async () => ({}) as never
  }
  const update = (tagChanges: { add?: string[]; remove?: string[] }) =>
    updateRuntimeManagedWorktreeMetadata({
      selector: 'id:repo::/wt',
      updates: { tagChanges },
      store,
      ports
    })
  return { update, tags: () => metaById.get('repo::/wt')?.tags }
}

describe('host-side tag edits', () => {
  it('keeps both of two concurrent adds', async () => {
    const host = setup(['billing'])
    await Promise.all([host.update({ add: ['api'] }), host.update({ add: ['urgent'] })])
    expect(host.tags()).toEqual(['billing', 'api', 'urgent'])
  })

  it('removes case-insensitively against the stored set', async () => {
    const host = setup(['Billing', 'api'])
    await host.update({ remove: ['billing'] })
    expect(host.tags()).toEqual(['api'])
  })
})
