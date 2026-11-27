import { ipcRenderer } from 'electron'
import type { GitStagingArea } from '../../../shared/git/status/git-status-types'
import type { GitSubmoduleRepo } from '../../../shared/git/status/git-submodule-repo-types'

export const gitSubmoduleBridge = {
  submoduleStatus: (args: {
    worktreePath: string
    submodulePath: string
    connectionId?: string
    area?: GitStagingArea
  }) => ipcRenderer.invoke('git:submoduleStatus', args),
  submoduleRepos: (args: {
    worktreePath: string
    connectionId?: string
  }): Promise<GitSubmoduleRepo[]> => ipcRenderer.invoke('git:submoduleRepos', args)
}
