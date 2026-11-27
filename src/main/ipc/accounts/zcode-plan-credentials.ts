import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  clearZcodePlanApiKeyCredential,
  getZcodePlanCredentialsStatus,
  saveZcodePlanApiKeyCredential
} from '../../zcode/zcode-plan-credential-commands'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

export function registerZcodePlanCredentialsHandlers(
  rateLimits: RateLimitService | null,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('zcodePlanCredentials:getStatus', () => getZcodePlanCredentialsStatus())
  ipc.handle('zcodePlanCredentials:saveApiKey', (_event, key: unknown) =>
    saveZcodePlanApiKeyCredential(rateLimits, key)
  )
  ipc.handle('zcodePlanCredentials:clearApiKey', () => clearZcodePlanApiKeyCredential(rateLimits))
}
