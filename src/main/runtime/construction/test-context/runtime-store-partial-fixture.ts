import type { RuntimeStore } from '../runtime-store-contract'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

type RuntimeSettings = ReturnType<RuntimeStore['getSettings']>

export type PartialRuntimeStore = Partial<Omit<RuntimeStore, 'getSettings'>> & {
  // Any persisted setting may be stubbed: the store returns all of them, not just the runtime's.
  getSettings?: () => Partial<RuntimeSettings> &
    Partial<Omit<GlobalSettings, keyof RuntimeSettings>>
}

function unstubbedWrite(member: string): () => never {
  return () => {
    throw new Error(`runtime store fake does not stub ${member}`)
  }
}

/** A runtime store fake: empty reads and refused writes beyond the members a test supplies. */
export function partialRuntimeStore(overrides: PartialRuntimeStore = {}): RuntimeStore {
  const { getSettings, ...members } = overrides
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    addRepo: unstubbedWrite('addRepo'),
    updateRepo: unstubbedWrite('updateRepo'),
    setWorktreeMeta: unstubbedWrite('setWorktreeMeta'),
    removeWorktreeMeta: unstubbedWrite('removeWorktreeMeta'),
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

/** A persisted folder workspace row as the store returns it. */
export function storeFolderWorkspace(
  fields: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'folderPath'>
): FolderWorkspace {
  return {
    name: fields.id,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}
