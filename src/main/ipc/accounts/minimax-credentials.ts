import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  clearMiniMaxApiKeyCredential,
  clearMiniMaxSessionCookieCredential,
  getMiniMaxCredentialsStatus,
  saveMiniMaxApiKeyCredential,
  saveMiniMaxSessionCookieCredential
} from '../../minimax/minimax-credential-commands'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

export function registerMiniMaxCredentialsHandlers(
  rateLimits: RateLimitService | null,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  ipc.handle('minimaxCredentials:saveCookie', (_event, cookie: unknown) =>
    saveMiniMaxSessionCookieCredential(rateLimits, cookie)
  )
  ipc.handle('minimaxCredentials:clearCookie', () =>
    clearMiniMaxSessionCookieCredential(rateLimits)
  )
  ipc.handle('minimaxCredentials:saveApiKey', (_event, key: unknown) =>
    saveMiniMaxApiKeyCredential(rateLimits, key)
  )
  ipc.handle('minimaxCredentials:clearApiKey', () => clearMiniMaxApiKeyCredential(rateLimits))
}
