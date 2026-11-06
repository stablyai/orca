import { ipcRenderer } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PreloadApi } from '../api-types'

export const hooksApi = {
  check: (args: { repoId: string; hostId?: ExecutionHostId; background?: boolean }) =>
    ipcRenderer.invoke('hooks:check', args),

  inspectSetupScriptImports: (args: { repoId: string; hostId?: ExecutionHostId }) =>
    ipcRenderer.invoke('hooks:inspectSetupScriptImports', args),

  readIssueCommand: (args: {
    repoId: string
    hostId?: ExecutionHostId
    wakeWslDistro?: boolean
  }): Promise<{
    status?: 'ok' | 'error'
    localContent: string | null
    sharedContent: string | null
    effectiveContent: string | null
    localFilePath: string
    source: 'local' | 'shared' | 'none'
    refusedWslDistro?: string
  }> => ipcRenderer.invoke('hooks:readIssueCommand', args),

  writeIssueCommand: (args: {
    repoId: string
    content: string
    hostId?: ExecutionHostId
    wakeWslDistro?: boolean
  }): Promise<void> => ipcRenderer.invoke('hooks:writeIssueCommand', args)
} satisfies PreloadApi['hooks']
