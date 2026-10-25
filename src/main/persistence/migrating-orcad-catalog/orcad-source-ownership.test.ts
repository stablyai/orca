import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { orcadMigrationCutoverFixture } from '../../ssh/orcad-migration-cutover-fixture'
import { collectOrcadMigrationSourceCatalog } from './orcad-source-catalog'
import { subtractOrcadSourceCatalogState } from './orcad-source-catalog-subtraction'
import { orcadSourceFolderWorkspaceIds, repoBelongsToOrcadSource } from './orcad-source-ownership'

const TARGET = 'ssh-win'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return { displayName: overrides.id, badgeColor: '#000', addedAt: 0, ...overrides }
}

function folder(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id'>
): FolderWorkspace {
  return {
    projectGroupId: 'group-folders',
    name: overrides.id,
    folderPath: 'C:\\Users\\Ann\\work',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const group: ProjectGroup = {
  id: 'group-folders',
  name: 'Folders',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

/** A Windows relay host: drive-letter paths whose case differs between rows. */
function windowsCatalog() {
  return {
    repos: [
      repo({ id: 'repo-app', path: 'C:\\Users\\Ann\\work\\app', connectionId: TARGET }),
      repo({ id: 'repo-unified', path: 'D:/src/tool', executionHostId: `ssh:${TARGET}` }),
      repo({ id: 'repo-local', path: 'C:\\Users\\Ann\\local' })
    ],
    projectGroups: [group],
    folderWorkspaces: [
      // No connection of its own: the repo inside it, matched case-insensitively, places it.
      folder({ id: 'fw-inferred', folderPath: 'c:/users/ann/WORK' }),
      folder({ id: 'fw-explicit', folderPath: 'C:\\elsewhere', connectionId: TARGET }),
      folder({ id: 'fw-local', folderPath: 'C:\\Users\\Ann\\local' }),
      folder({ id: 'fw-other', folderPath: 'C:\\Users\\Ann\\work', connectionId: 'ssh-other' })
    ]
  }
}

describe('orcad migration source ownership on a Windows SSH host', () => {
  it('owns repos by either host spelling and folders the way the app attributes them', () => {
    const catalog = windowsCatalog()
    expect(
      catalog.repos.filter((entry) => repoBelongsToOrcadSource(entry, TARGET)).map(({ id }) => id)
    ).toEqual(['repo-app', 'repo-unified'])
    expect([...orcadSourceFolderWorkspaceIds(catalog, TARGET)].sort()).toEqual([
      'fw-explicit',
      'fw-inferred'
    ])
  })

  it('exports exactly those rows', () => {
    const catalog = windowsCatalog()
    const exported = collectOrcadMigrationSourceCatalog(
      {
        getRepos: () => catalog.repos,
        getProjectGroups: () => catalog.projectGroups,
        getFolderWorkspaces: () => catalog.folderWorkspaces
      },
      { id: TARGET }
    )
    expect(exported.repositories.map(({ id }) => id)).toEqual(['repo-app', 'repo-unified'])
    expect(exported.folderWorkspaces.map(({ id }) => id).sort()).toEqual([
      'fw-explicit',
      'fw-inferred'
    ])
  })

  it('retires a folder owned through its repo even though the repo goes first', () => {
    const catalog = windowsCatalog()
    const state = { ...getDefaultPersistedState('C:/Users/Ann'), ...catalog }
    const fixture = orcadMigrationCutoverFixture('migration-1', TARGET)
    subtractOrcadSourceCatalogState(state, {
      ...fixture.manifest,
      payload: {
        repositories: catalog.repos.slice(0, 2),
        projectGroups: [],
        folderWorkspaces: catalog.folderWorkspaces.slice(0, 2)
      }
    })
    expect(state.repos.map(({ id }) => id)).toEqual(['repo-local'])
    expect(state.folderWorkspaces.map(({ id }) => id)).toEqual(['fw-local', 'fw-other'])
  })
})
