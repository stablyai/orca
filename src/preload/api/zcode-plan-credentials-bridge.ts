import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { ZcodePlanCredentialsStatus } from '../../shared/zcode-plan-sites'

export const zcodePlanCredentialsApi = {
  getStatus: (): Promise<ZcodePlanCredentialsStatus> =>
    ipcRenderer.invoke('zcodePlanCredentials:getStatus'),
  saveApiKey: (key: string): Promise<ZcodePlanCredentialsStatus> =>
    ipcRenderer.invoke('zcodePlanCredentials:saveApiKey', key),
  clearApiKey: (): Promise<ZcodePlanCredentialsStatus> =>
    ipcRenderer.invoke('zcodePlanCredentials:clearApiKey')
} satisfies PreloadApi['zcodePlanCredentials']
