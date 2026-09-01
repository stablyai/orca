import { ipcRenderer } from 'electron'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'

export const codexConfigSyncApi = {
  status: (): Promise<CodexConfigSyncStatus> => ipcRenderer.invoke('codexConfigSync:status')
}
