import type { Project } from '../../../../shared/project/project-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'

type CatalogStoreOverrides = Partial<Omit<RuntimeStore, 'getSettings'>> & {
  getSettings?: () => Partial<ReturnType<RuntimeStore['getSettings']>>
}

function unexpectedWrite(): never {
  throw new Error('Unexpected write to the catalog test store')
}

export function catalogRuntimeStore(overrides: CatalogStoreOverrides): RuntimeStore {
  const { getSettings, ...members } = overrides
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    addRepo: unexpectedWrite,
    updateRepo: unexpectedWrite,
    setWorktreeMeta: unexpectedWrite,
    removeWorktreeMeta: unexpectedWrite,
    ...members,
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      ...getSettings?.()
    })
  }
}

export function storeRepo(fields: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return { displayName: fields.id, badgeColor: '#737373', addedAt: 0, ...fields }
}

export function storeProject(fields: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    displayName: fields.id,
    badgeColor: '#737373',
    sourceRepoIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}
