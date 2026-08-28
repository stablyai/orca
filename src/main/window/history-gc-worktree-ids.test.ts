/**
 * The GC live set decides what history is "orphaned". Anything missing from it
 * gets deleted, so a workspace kind that owns history and is absent here is a
 * data-loss bug — that is what reverted #14863 (#14975).
 */
import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { getKnownWorktreeIdsForHistoryGc } from './history-gc-worktree-ids'

const noOtherProfiles = () => ({ ids: new Set<string>(), unreadableProfiles: 0 })

const store = (worktreeIds: string[], folderIds: string[]) =>
  ({
    getAllWorktreeMeta: () => Object.fromEntries(worktreeIds.map((id) => [id, {}])),
    getFolderWorkspaces: () => folderIds.map((id) => ({ id }))
  }) as never

describe('getKnownWorktreeIdsForHistoryGc', () => {
  it('includes git worktrees', () => {
    expect(
      getKnownWorktreeIdsForHistoryGc(store(['repo-1::/path/wt'], []), noOtherProfiles)
    ).toEqual(new Set(['repo-1::/path/wt']))
  })

  // Why: a folder workspace's PTY carries `folder:<id>` as its worktree id, so
  // injectHistoryEnv mints history under that key. They live in a separate store
  // collection, so a set built only from worktree metadata makes every live
  // folder workspace look orphaned and its history gets swept on a later start.
  it('includes folder workspaces under their PTY workspace key', () => {
    const live = getKnownWorktreeIdsForHistoryGc(
      store(['repo-1::/path/wt'], ['fw-1', 'fw-2']),
      noOtherProfiles
    )

    expect(live.has(folderWorkspaceKey('fw-1'))).toBe(true)
    expect(live.has(folderWorkspaceKey('fw-2'))).toBe(true)
    expect(live.size).toBe(3)
  })

  it('is empty only when there is genuinely nothing live', () => {
    expect(getKnownWorktreeIdsForHistoryGc(store([], []), noOtherProfiles).size).toBe(0)
  })

  // Why: the history root has no profile segment but the store does, so the
  // other profiles' worktrees own history this set would otherwise condemn the
  // first time the user switches profiles.
  it('includes worktrees owned by other profiles', () => {
    const live = getKnownWorktreeIdsForHistoryGc(store(['repo-1::/b'], ['fw-b']), () => ({
      ids: new Set(['repo-1::/a', folderWorkspaceKey('fw-a')]),
      unreadableProfiles: 0
    }))

    expect(live).toEqual(
      new Set(['repo-1::/b', folderWorkspaceKey('fw-b'), 'repo-1::/a', folderWorkspaceKey('fw-a')])
    )
  })

  // Why empty and not "just the ids we did read": an unreadable profile's
  // worktrees are indistinguishable from deleted ones, and runHistoryGc refuses
  // to prune on an empty set — so this reports "do not collect" rather than
  // handing back a set that condemns real history.
  it('reports nothing live when a profile could not be read', () => {
    const live = getKnownWorktreeIdsForHistoryGc(store(['repo-1::/b'], ['fw-b']), () => ({
      ids: new Set(['repo-1::/a']),
      unreadableProfiles: 1
    }))

    expect(live.size).toBe(0)
  })
})
