import type { RuntimeStore } from './runtime-store-contract'

const unexpected = (): never => {
  throw new Error('Unexpected runtime store call')
}

export function runtimeStoreFixture(overrides: Partial<RuntimeStore> = {}): RuntimeStore {
  return {
    getRepos: unexpected,
    getRepo: unexpected,
    addRepo: unexpected,
    updateRepo: unexpected,
    getAllWorktreeMeta: unexpected,
    getWorktreeMeta: unexpected,
    setWorktreeMeta: unexpected,
    removeWorktreeMeta: unexpected,
    getGitHubCache: unexpected,
    getSettings: unexpected,
    ...overrides
  }
}
