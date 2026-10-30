import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeFolderWorkspaces } from '../../../shared/folder-workspaces'
import { FolderWorkspacePersistenceOperations } from './folder-workspace-operations'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

function createOperations() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder operations read only these fields.
  const state = {
    projectGroups: [{ id: 'group-1', parentPath: '/tmp/folder' }],
    folderWorkspaces: []
  } as unknown as PersistedState
  const operations = new FolderWorkspacePersistenceOperations({
    state,
    scheduleSave: () => {},
    removeWorkspaceLineageForFolderParent: () => {},
    pruneMobileClientTabSelections: () => {},
    hydrateRepo: (repo) => repo
  })
  return Object.assign(operations, { projectGroups: state.projectGroups ?? [] })
}

describe('folder workspace sort stamps', () => {
  it('stamps creation as the first Recent stamp', () => {
    vi.useFakeTimers({ now: 5_000 })
    try {
      expect(createOperations().createFolderWorkspace({ projectGroupId: 'group-1' })).toMatchObject(
        { lastActivityAt: 5_000, createdAt: 5_000 }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes the tier as a pair, clears it for Rest, and keeps it across a load', () => {
    const operations = createOperations()
    const { id } = operations.createFolderWorkspace({ projectGroupId: 'group-1' })
    operations.updateFolderWorkspace(id, { lastActivityAt: 9, smartTier: 'done', smartAt: 9 })
    const stamped = operations.getFolderWorkspace(id)
    expect(stamped).toMatchObject({ smartTier: 'done', smartAt: 9 })
    expect(
      normalizeFolderWorkspaces([JSON.parse(JSON.stringify(stamped))], operations.projectGroups)[0]
    ).toMatchObject({
      smartTier: 'done',
      smartAt: 9
    })

    operations.updateFolderWorkspace(id, { smartTier: undefined, smartAt: undefined })
    expect(operations.getFolderWorkspace(id)?.smartTier).toBeUndefined()
    expect(operations.getFolderWorkspace(id)?.smartAt).toBeUndefined()
    operations.updateFolderWorkspace(id, { smartTier: 'working', smartAt: 10 })
    operations.updateFolderWorkspace(id, { comment: 'x' })
    expect(operations.getFolderWorkspace(id)).toMatchObject({ smartTier: 'working', smartAt: 10 })
  })
})
