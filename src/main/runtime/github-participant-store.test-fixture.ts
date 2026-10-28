import type { RuntimeStore } from './construction/runtime-store-contract'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { Repo } from '../../shared/repository/repo-types'

type RuntimeSettings = ReturnType<RuntimeStore['getSettings']>

export type ParticipantRuntimeStore = Partial<Omit<RuntimeStore, 'getSettings'>> & {
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
export function participantRuntimeStore(overrides: ParticipantRuntimeStore = {}): RuntimeStore {
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

/** A persisted repo row as the store returns it. */
export function participantRepo(fields: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return { displayName: fields.id, badgeColor: '#737373', addedAt: 0, ...fields }
}
