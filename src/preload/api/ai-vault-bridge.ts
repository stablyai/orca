import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchRequest, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import { ipcRenderer } from 'electron'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultListArgs,
  AiVaultSubagentListArgs
} from '../../shared/ai-vault-types'
import type { AiVaultSessionTitlesArgs } from '../../shared/ai-vault-session-title'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import type { PreloadApi } from '../api-types'

function searchClient(
  executionHostScope?: ExecutionHostScope
): ReturnType<typeof createSessionSearchClient> {
  // `all` is merged by this desktop, which already redacted each remote leg.
  const remote =
    executionHostScope !== undefined &&
    executionHostScope !== LOCAL_EXECUTION_HOST_ID &&
    executionHostScope !== ALL_EXECUTION_HOSTS_SCOPE
  return createSessionSearchClient(
    (method, params) =>
      method === 'aiVault.searchSessions'
        ? ipcRenderer.invoke('aiVault:searchSessions', params, executionHostScope)
        : ipcRenderer.invoke('aiVault:searchStatus', executionHostScope),
    remote ? 'relay' : 'ipc'
  )
}

export const aiVaultApi = {
  searchSessions: (request: AiVaultSearchRequest, executionHostScope?: ExecutionHostScope) =>
    searchClient(executionHostScope).searchSessions(request),
  searchStatus: (executionHostScope?: ExecutionHostId) =>
    searchClient(executionHostScope).searchStatus(),
  setSearchEnabled: (
    executionHostId: ExecutionHostId,
    enabled: boolean
  ): Promise<AiVaultSearchStatus> =>
    ipcRenderer.invoke('aiVault:setSearchEnabled', executionHostId, enabled),
  clearSearchIndex: (): Promise<void> => ipcRenderer.invoke('aiVault:clearSearchIndex'),
  listSessions: (args?: AiVaultListArgs) => ipcRenderer.invoke('aiVault:listSessions', args),
  resolveSessionTitles: (args: AiVaultSessionTitlesArgs) =>
    ipcRenderer.invoke('aiVault:resolveSessionTitles', args),
  cancelListSessions: (args: { requestToken: string }): Promise<void> =>
    ipcRenderer.invoke('aiVault:cancelListSessions', args),
  prepareSessionResume: (args: AiVaultPrepareSessionResumeArgs) =>
    ipcRenderer.invoke('aiVault:prepareSessionResume', args),
  listSubagentSessions: (args: AiVaultSubagentListArgs) =>
    ipcRenderer.invoke('aiVault:listSubagentSessions', args),
  getFirstUserPrompt: (args: AiVaultFirstUserPromptArgs) =>
    ipcRenderer.invoke('aiVault:getFirstUserPrompt', args),
  deleteSession: (args: AiVaultDeleteSessionArgs): Promise<AiVaultDeleteSessionResult> =>
    ipcRenderer.invoke('aiVault:deleteSession', args),
  onWindowFocused: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('aiVault:windowFocused', listener)
    return () => ipcRenderer.removeListener('aiVault:windowFocused', listener)
  }
} satisfies PreloadApi['aiVault']
