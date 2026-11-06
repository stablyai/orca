import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { DependentStateStore } from './ssh-target-orcad-dependents'

export function emptyDependentStateStore(
  overrides: Partial<DependentStateStore> = {}
): DependentStateStore {
  return {
    getAllWorktreeMetaForHost: () => ({}),
    getProjects: () => [],
    getRepos: () => [],
    getSshRemotePtyLeases: () => [],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => ['local'],
    listAutomations: () => [],
    ...overrides
  }
}
