/** An incomplete GC live set deletes owned history; regressions here caused the #14863 revert (#14975). */
import { describe, expect, it } from 'vitest'
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

  // Folder PTYs mint history under folder:<id>; omitting their separate store collection falsely marks live history orphaned.

  // History is not profile-scoped, so other profiles must remain in the live set.

  // Unreadable profiles make ownership unknown; empty means prune nothing, while partial IDs would delete live history.
  it('reports nothing live when a profile could not be read', () => {
    const live = getKnownWorktreeIdsForHistoryGc(store(['repo-1::/b'], ['fw-b']), () => ({
      ids: new Set(['repo-1::/a']),
      unreadableProfiles: 1
    }))

    expect(live.size).toBe(0)
  })
})
