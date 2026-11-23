import { ipcRenderer } from 'electron'
import type { CodexConfigSyncStatus } from '../../../shared/agent-accounts/codex/codex-config-sync-types'
import type { PreloadApi } from '../../api-types'

export const codexConfigSyncApi = {
  status: (): Promise<CodexConfigSyncStatus> => ipcRenderer.invoke('codexConfigSync:status')
} satisfies PreloadApi['codexConfigSync']
