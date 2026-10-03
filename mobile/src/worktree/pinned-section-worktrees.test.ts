import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import { getPinnedSectionWorktrees } from './pinned-section-worktrees'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'worktree',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

const isPinned = (w: Worktree): boolean => w.isPinned

describe('getPinnedSectionWorktrees', () => {
  it('includes only explicitly pinned rows when there is no lineage', () => {
    const pinned = worktree({ worktreeId: 'pinned', isPinned: true })
    const loose = worktree({ worktreeId: 'loose' })

    expect(
      getPinnedSectionWorktrees([pinned, loose], [pinned, loose], isPinned).map((w) => w.worktreeId)
    ).toEqual(['pinned'])
  })

  it('includes visible descendants of a pinned parent', () => {
    const parent = worktree({ worktreeId: 'parent', isPinned: true })
    const child = worktree({ worktreeId: 'child', parentWorktreeId: 'parent' })
    const grandchild = worktree({ worktreeId: 'grandchild', parentWorktreeId: 'child' })
    const sibling = worktree({ worktreeId: 'sibling' })

    expect(
      getPinnedSectionWorktrees(
        [parent, child, grandchild, sibling],
        [parent, child, grandchild, sibling],
        isPinned
      ).map((w) => w.worktreeId)
    ).toEqual(['parent', 'child', 'grandchild'])
  })

  it("does not pull a pinned child's unpinned parent into the Pinned section", () => {
    const parent = worktree({ worktreeId: 'parent' })
    const pinnedChild = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      isPinned: true
    })

    expect(
      getPinnedSectionWorktrees([parent, pinnedChild], [parent, pinnedChild], isPinned).map(
        (w) => w.worktreeId
      )
    ).toEqual(['child'])
  })

  it('includes a pinned descendant exactly once when it is also explicitly pinned', () => {
    const parent = worktree({ worktreeId: 'parent', isPinned: true })
    const child = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      isPinned: true
    })

    expect(
      getPinnedSectionWorktrees([parent, child], [parent, child], isPinned).map((w) => w.worktreeId)
    ).toEqual(['parent', 'child'])
  })

  it('keeps a visible grandchild when the middle parent is filtered out of the visible rows', () => {
    const parent = worktree({ worktreeId: 'parent', isPinned: true })
    const child = worktree({ worktreeId: 'child', parentWorktreeId: 'parent' })
    const grandchild = worktree({ worktreeId: 'grandchild', parentWorktreeId: 'child' })

    expect(
      getPinnedSectionWorktrees([parent, child, grandchild], [parent, grandchild], isPinned).map(
        (w) => w.worktreeId
      )
    ).toEqual(['parent', 'grandchild'])
  })

  it('does not collect descendants of a pinned parent that is not itself visible', () => {
    const parent = worktree({ worktreeId: 'parent', isPinned: true })
    const child = worktree({ worktreeId: 'child', parentWorktreeId: 'parent' })

    expect(getPinnedSectionWorktrees([parent, child], [child], isPinned)).toEqual([])
  })

  it('honors client-side local pins through the predicate', () => {
    const parent = worktree({ worktreeId: 'parent' })
    const child = worktree({ worktreeId: 'child', parentWorktreeId: 'parent' })
    const localPins = new Set(['parent'])

    expect(
      getPinnedSectionWorktrees(
        [parent, child],
        [parent, child],
        (w) => w.isPinned || localPins.has(w.worktreeId)
      ).map((w) => w.worktreeId)
    ).toEqual(['parent', 'child'])
  })

  it('never follows lineage edges across execution hosts', () => {
    const localParent = worktree({ worktreeId: 'shared', hostId: 'local', isPinned: true })
    const remoteChild = worktree({
      worktreeId: 'remote-child',
      hostId: 'ssh:box',
      parentWorktreeId: 'shared'
    })

    expect(
      getPinnedSectionWorktrees(
        [localParent, remoteChild],
        [localParent, remoteChild],
        isPinned
      ).map((w) => w.worktreeId)
    ).toEqual(['shared'])
  })

  it('rejects stale lineage when instance ids no longer match', () => {
    const parent = worktree({
      worktreeId: 'parent',
      worktreeInstanceId: 'new-parent',
      isPinned: true
    })
    const child = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'old-parent'
    })

    expect(
      getPinnedSectionWorktrees([parent, child], [parent, child], isPinned).map((w) => w.worktreeId)
    ).toEqual(['parent'])
  })

  it('terminates on cyclic lineage', () => {
    const first = worktree({ worktreeId: 'first', parentWorktreeId: 'second', isPinned: true })
    const second = worktree({ worktreeId: 'second', parentWorktreeId: 'first' })

    expect(
      getPinnedSectionWorktrees([first, second], [first, second], isPinned)
        .map((w) => w.worktreeId)
        .sort()
    ).toEqual(['first', 'second'])
  })

  it('walks a deep lineage chain without recursing', () => {
    const depth = 6_000
    const rows: Worktree[] = []
    for (let index = 0; index < depth; index++) {
      rows.push(
        worktree({
          worktreeId: `deep-${index}`,
          isPinned: index === 0,
          ...(index > 0 ? { parentWorktreeId: `deep-${index - 1}` } : {})
        })
      )
    }

    expect(getPinnedSectionWorktrees(rows, rows, isPinned)).toHaveLength(depth)
  })
})
