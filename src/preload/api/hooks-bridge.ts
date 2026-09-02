import { ipcRenderer } from 'electron'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PreloadApi } from '../api-types'

export const hooksApi = {
  check: (args: { repoId: string; hostId?: ExecutionHostId }) =>
    ipcRenderer.invoke('hooks:check', args),

  inspectSetupScriptImports: (args: { repoId: string; hostId?: ExecutionHostId }) =>
    ipcRenderer.invoke('hooks:inspectSetupScriptImports', args),

  createIssueCommandRunner: (args: {
    repoId: string
    worktreePath: string
    command: string
  }): Promise<WorktreeSetupLaunch> => ipcRenderer.invoke('hooks:createIssueCommandRunner', args),

  readIssueCommand: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }): Promise<{
    status?: 'ok' | 'error'
    localContent: string | null
    sharedContent: string | null
    effectiveContent: string | null
    localFilePath: string
    source: 'local' | 'shared' | 'none'
  }> => ipcRenderer.invoke('hooks:readIssueCommand', args),

  writeIssueCommand: (args: {
    repoId: string
    content: string
    hostId?: ExecutionHostId
  }): Promise<void> => ipcRenderer.invoke('hooks:writeIssueCommand', args)
} satisfies PreloadApi['hooks']
