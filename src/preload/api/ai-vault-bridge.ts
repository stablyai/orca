import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchRequest, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import type { ExecutionHostId, ExecutionHostScope } from '../../shared/execution-host'
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
import type { AiVaultPrepareSessionResumeRequest } from '../../shared/ai-vault-resume-preparation'
import type { PreloadApi } from '../api-types'
import {
  AI_VAULT_SCAN_PROGRESS_CHANNEL,
  type AiVaultScanProgress,
  type AiVaultScanProgressUpdate
} from '../../shared/ai-vault-scan-progress'

function searchClient(
  executionHostScope?: ExecutionHostScope
): ReturnType<typeof createSessionSearchClient> {
  // Main negotiates and redacts every remote leg before answering this same-build IPC boundary.
  return createSessionSearchClient(
    (method, params) =>
      method === 'aiVault.searchSessions'
        ? ipcRenderer.invoke('aiVault:searchSessions', params, executionHostScope)
        : ipcRenderer.invoke('aiVault:searchStatus', executionHostScope),
    'ipc'
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
  prepareSessionResume: (args: AiVaultPrepareSessionResumeRequest) =>
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
  },
  getScanProgress: (scanKey: string): Promise<AiVaultScanProgress | null> =>
    ipcRenderer.invoke('aiVault:getScanProgress', scanKey),
  onScanProgress: (callback: (update: AiVaultScanProgressUpdate) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: AiVaultScanProgressUpdate) =>
      callback(update)
    ipcRenderer.on(AI_VAULT_SCAN_PROGRESS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(AI_VAULT_SCAN_PROGRESS_CHANNEL, listener)
  }
} satisfies PreloadApi['aiVault']
