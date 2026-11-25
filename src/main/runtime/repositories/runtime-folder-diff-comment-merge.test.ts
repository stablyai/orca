import { describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { FolderDiffCommentMergeRequest } from '../../../shared/file-review/folder-diff-comment-merge'
import { mergeFolderDiffCommentsOnHost } from '../../../shared/file-review/folder-diff-comment-merge-operation'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { runtimeFolderDiffCommentMergeHost } from './runtime-folder-diff-comment-merge'
import type * as WslMoveScopeGuard from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

const fenced = new Set<string>()

vi.mock('../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard', async (load) => {
  const actual = await load<typeof WslMoveScopeGuard>()
  return {
    ...actual,
    // Stands in for a WSL move journal fencing one folder: a non-passive write throws.
    shouldDropWslMoveProjectUpdate: (
      _store: unknown,
      ref: { folderWorkspaceId?: string } | null
    ) => {
      if (ref?.folderWorkspaceId && fenced.has(ref.folderWorkspaceId)) {
        throw new actual.WslMoveProjectFencedError()
      }
      return false
    }
  }
})

function note(id: string, body: string): DiffComment {
  return {
    id,
    worktreeId: 'folder:f1',
    filePath: 'a.md',
    lineNumber: 1,
    body,
    side: 'modified',
    createdAt: 1
  }
}

function setup(diffComments: DiffComment[]) {
  let row = {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'folder',
    folderPath: '/w',
    diffComments,
    createdAt: 7,
    updatedAt: 1
  } as unknown as FolderWorkspace
  const effects = { updates: 0, notifies: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the catalog reads and the folder update the merge host uses.
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [],
    getSshTargets: () => [],
    getProjectHostSetups: () => [],
    getFolderWorkspaces: () => [row],
    updateFolderWorkspace: (_id: string, updates: { diffComments: DiffComment[] }) => {
      effects.updates += 1
      row = { ...row, diffComments: updates.diffComments }
      return row
    }
  } as unknown as RuntimeStore
  const host = runtimeFolderDiffCommentMergeHost(store, () => {
    effects.notifies += 1
  })
  return {
    effects,
    merge: (request: FolderDiffCommentMergeRequest) => mergeFolderDiffCommentsOnHost(host, request)
  }
}

const request = (
  overrides: Partial<FolderDiffCommentMergeRequest>
): FolderDiffCommentMergeRequest => ({
  requestId: 'r1',
  folderWorkspaceId: 'f1',
  expectedCreatedAt: 7,
  mode: 'merge',
  diffCommentsBase: [],
  diffComments: [note('Y', 'y')],
  ...overrides
})

describe('paired runtime folder note merge host', () => {
  it('refuses a note write to a folder a WSL move fences, with no write or notification', () => {
    const { effects, merge } = setup([note('X', 'x')])
    fenced.add('f1')
    try {
      expect(merge(request({}))).toMatchObject({ outcome: 'refused' })
    } finally {
      fenced.clear()
    }
    expect(effects).toEqual({ updates: 0, notifies: 0 })
  })

  it('answers a read and a stale incarnation without writing or notifying', () => {
    const { effects, merge } = setup([note('X', 'x')])

    expect(merge(request({ mode: 'read', diffComments: [] }))).toMatchObject({ outcome: 'read' })
    expect(merge(request({ expectedCreatedAt: 6 }))).toMatchObject({
      outcome: 'incarnation_changed'
    })
    expect(effects).toEqual({ updates: 0, notifies: 0 })

    expect(merge(request({}))).toMatchObject({ outcome: 'applied' })
    expect(effects).toEqual({ updates: 1, notifies: 1 })
  })
})
