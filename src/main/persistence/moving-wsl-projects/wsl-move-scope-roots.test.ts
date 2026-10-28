import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { OrcadMigrationDormantStatePayload } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoveScopeRootPaths } from './wsl-move-scope-roots'

const dormant: OrcadMigrationDormantStatePayload = {
  version: 1,
  worktreeMeta: [],
  worktreeLineage: [],
  workspaceLineage: [],
  sparsePresets: [],
  retiredWorktreeNames: [],
  retiredWorktreeNamespaces: [],
  workspaceSession: {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      'worktree:repo-1::/home/dev/trees/feature': [],
      'repo-1::/home/dev/trees/fix::workspace:00000000-0000-0000-0000-000000000000': [],
      'folder:folder-1': []
    }
  }
}

describe('wslMoveScopeRootPaths', () => {
  it('names each moved repo, folder and carried worktree directory on the host', () => {
    const { manifest } = cutover(
      'move-1',
      'destination-committed',
      {},
      { repoIds: ['repo-1'], folderWorkspaceIds: ['folder-1'] },
      dormant
    )
    expect(wslMoveScopeRootPaths(manifest)).toEqual([
      '/home/dev/repo-1',
      '/srv/folder-1',
      '/home/dev/trees/feature',
      '/home/dev/trees/fix'
    ])
  })

  it('lists only the repos and folders without dormant state', () => {
    expect(wslMoveScopeRootPaths(cutover('move-1', 'destination-committed').manifest)).toEqual([
      '/home/dev/repo-1'
    ])
  })
})
