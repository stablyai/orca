import { describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import {
  ABSENT_NOTE_VERSION,
  diffCommentVersion
} from '../../../shared/file-review/diff-comment-recovery'
import { FolderWorkspacePersistenceOperations } from './folder-workspace-operations'

function note(id: string, body: string): DiffComment {
  return {
    id,
    worktreeId: 'folder:folder-1',
    filePath: 'README.md',
    lineNumber: 1,
    body,
    side: 'modified',
    createdAt: 1
  }
}

function hostHolding(diffComments: DiffComment[]) {
  const workspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'folder',
    folderPath: '/workspace',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    diffComments
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial state with only the folder rows a folder update reads.
  const state = { folderWorkspaces: [workspace] } as unknown as PersistedState
  const operations = new FolderWorkspacePersistenceOperations({
    state,
    scheduleSave: vi.fn(),
    removeWorkspaceLineageForRemovedFolder: vi.fn(),
    pruneMobileClientTabSelections: vi.fn(),
    hydrateRepo: (repo) => repo
  })
  return {
    recover(requested: DiffComment[], known: Record<string, (DiffComment | undefined)[]>) {
      return operations.updateFolderWorkspace('folder-1', {
        diffComments: requested,
        diffCommentsRecovery: {
          known: Object.entries(known).map(([id, versions]) => ({
            id,
            versions: versions.map(diffCommentVersion)
          }))
        }
      })
    }
  }
}

describe('folder review-note recovery on the host', () => {
  it('keeps an edit another device made to a landed add, even one made just before this write', () => {
    // This copy's add of X landed but its reply was lost, so it rolled X back and shows no X.
    const sentX = note('x', 'mine')
    const host = hostHolding([note('x', 'edited elsewhere')])

    const updated = host.recover([note('y', 'new')], { x: [undefined, sentX] })

    expect(updated?.diffComments).toEqual([note('x', 'edited elsewhere'), note('y', 'new')])
    // The recovery is only how the write is decided; it is never stored.
    expect(updated).not.toHaveProperty('diffCommentsRecovery')
  })

  it('removes a landed add only while the host still holds the exact version this copy sent', () => {
    const sentX = note('x', 'mine')
    const host = hostHolding([sentX])

    const updated = host.recover([note('y', 'new')], { x: [undefined, sentX] })

    expect(updated?.diffComments).toEqual([note('y', 'new')])
  })

  it('does not bring back a note another device deleted, nor undo its edit', () => {
    const x = note('x', 'v1')
    const z = note('z', 'v1')
    const host = hostHolding([note('z', 'v2 from another device')])

    const updated = host.recover([x, z, note('y', 'new')], { x: [x], z: [z] })

    expect(updated?.diffComments).toEqual([note('z', 'v2 from another device'), note('y', 'new')])
  })

  it("applies this copy's own edit and delete of notes it knew", () => {
    const x = note('x', 'v1')
    const z = note('z', 'v1')
    const host = hostHolding([x, z])

    const updated = host.recover([note('x', 'v1 edited here')], { x: [x], z: [z] })

    expect(updated?.diffComments).toEqual([note('x', 'v1 edited here')])
  })

  it('treats a note this copy never listed as absent from everything it knew', () => {
    expect(diffCommentVersion(undefined)).toBe(ABSENT_NOTE_VERSION)
    const host = hostHolding([note('peer', 'from another device')])

    const updated = host.recover([note('y', 'new')], {})

    expect(updated?.diffComments).toEqual([note('peer', 'from another device'), note('y', 'new')])
  })
})
