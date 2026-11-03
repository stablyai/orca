import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { OllamaCloudCredentialsStatus } from '../../shared/ollama-cloud'

export const ollamaCloudCredentialsApi = {
  getStatus: (): Promise<OllamaCloudCredentialsStatus> =>
    ipcRenderer.invoke('ollamaCloudCredentials:getStatus'),
  saveApiKey: (key: string): Promise<OllamaCloudCredentialsStatus> =>
    ipcRenderer.invoke('ollamaCloudCredentials:saveApiKey', key),
  clearApiKey: (): Promise<OllamaCloudCredentialsStatus> =>
    ipcRenderer.invoke('ollamaCloudCredentials:clearApiKey')
} satisfies PreloadApi['ollamaCloudCredentials']
