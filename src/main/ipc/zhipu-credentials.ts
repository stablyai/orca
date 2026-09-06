import { ipcMain } from 'electron'
import {
  clearZhipuCredentials,
  hasZhipuCredentials,
  readZhipuCredentials,
  saveZhipuCredentials
} from '../zhipu/zhipu-credential-store'
import { readCcSwitchZhipuCredentials } from '../zhipu/cc-switch-import'
import type { RateLimitService } from '../rate-limits/service'
import { ZHIPU_DEFAULT_BASE_URL } from '../../shared/zhipu-usage'

export type ZhipuCredentialsStatus = {
  configured: boolean
  baseUrl: string | null
}

export type ZhipuCredentialsImportStatus = ZhipuCredentialsStatus & {
  importedProviderName: string
}

function getZhipuCredentialsStatus(): ZhipuCredentialsStatus {
  let baseUrl: string | null = null
  try {
    baseUrl = readZhipuCredentials()?.baseUrl ?? null
  } catch {
    baseUrl = null
  }
  return {
    configured: hasZhipuCredentials(),
    baseUrl
  }
}

// Why: callers need the persisted status immediately; usage refresh can finish in the background.
function refreshAfterZhipuCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear' | 'import'
): void {
  rateLimits?.invalidateZhipuCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[zhipu] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerZhipuCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('zhipuCredentials:getStatus', () => getZhipuCredentialsStatus())
  ipcMain.handle('zhipuCredentials:save', (_event, args: unknown) => {
    if (
      typeof args !== 'object' ||
      args === null ||
      typeof (args as { authToken?: unknown }).authToken !== 'string' ||
      typeof (args as { baseUrl?: unknown }).baseUrl !== 'string'
    ) {
      throw new Error('Zhipu credentials must include baseUrl and authToken strings')
    }
    saveZhipuCredentials({
      baseUrl: (args as { baseUrl: string }).baseUrl || ZHIPU_DEFAULT_BASE_URL,
      authToken: (args as { authToken: string }).authToken
    })
    refreshAfterZhipuCredentialChange(rateLimits, 'save')
    return getZhipuCredentialsStatus()
  })
  ipcMain.handle('zhipuCredentials:clear', () => {
    clearZhipuCredentials()
    refreshAfterZhipuCredentialChange(rateLimits, 'clear')
    return getZhipuCredentialsStatus()
  })
  ipcMain.handle('zhipuCredentials:importFromCcSwitch', () => {
    const imported = readCcSwitchZhipuCredentials()
    saveZhipuCredentials({
      baseUrl: imported.baseUrl,
      authToken: imported.authToken
    })
    refreshAfterZhipuCredentialChange(rateLimits, 'import')
    return {
      ...getZhipuCredentialsStatus(),
      importedProviderName: imported.providerName
    }
  })
}
