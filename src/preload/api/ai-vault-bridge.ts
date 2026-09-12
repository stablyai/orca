import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchRequest } from '../../shared/ai-vault-search-types'
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

function searchClient(sshTargetId?: string): ReturnType<typeof createSessionSearchClient> {
  return createSessionSearchClient(
    (method, params) =>
      method === 'aiVault.searchSessions'
        ? ipcRenderer.invoke('aiVault:searchSessions', params, sshTargetId)
        : ipcRenderer.invoke('aiVault:searchStatus', sshTargetId),
    sshTargetId ? 'relay' : 'ipc'
  )
}

export const aiVaultApi = {
  searchSessions: (request: AiVaultSearchRequest, sshTargetId?: string) =>
    searchClient(sshTargetId).searchSessions(request),
  searchStatus: (sshTargetId?: string) => searchClient(sshTargetId).searchStatus(),
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
