import { homedir } from 'node:os'
import { createInitialFolderWorkspaceState } from '../../../shared/initial-folder-workspace-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { createLocalProjectRecord } from '../../workspaces/catalog/local-project-record'

export function createInitialHomeWorkspaceState(state: PersistedState): PersistedState {
  const home = createLocalProjectRecord({ path: homedir(), kind: 'folder', displayName: 'Home' })
  return createInitialFolderWorkspaceState(state, home)
}
