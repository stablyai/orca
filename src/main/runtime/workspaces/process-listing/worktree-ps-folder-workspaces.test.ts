import { describe, expect, it } from 'vitest'

import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProjectGroup
} from '../../orca-runtime-tests/runtime-store-partial-fixture'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'

const manualGroup = storeProjectGroup({ id: 'group-manual', name: 'Manual', parentPath: null })
const folderWorkspace = storeFolderWorkspace({
  id: 'folder-1',
  projectGroupId: manualGroup.id,
  folderPath: '/tmp/imported'
})

describe('worktree ps folder workspaces', () => {
  it('lists a folder workspace whose owning group has no base folder', () => {
    const summaries = buildRuntimeWorktreePsSummaries({
      store: partialRuntimeStore({
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [manualGroup]
      }),
      resolvedWorktrees: [],
      platformByRepoId: new Map()
    })

    expect(
      [...summaries.values()].map((summary) => ({
        kind: summary.workspaceKind,
        repo: summary.repo,
        path: summary.path
      }))
    ).toEqual([{ kind: 'folder-workspace', repo: 'Manual', path: folderWorkspace.folderPath }])
  })
})
