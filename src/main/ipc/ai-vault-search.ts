import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../ai-vault-search/session-search-service-registry'
import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import { requestActiveSshSessionSearch } from './ssh'

const targetSchema = z.string().min(1).optional()

export function registerAiVaultSearchHandlers(): void {
  ipcMain.handle('aiVault:searchSessions', (_event, raw: unknown, rawTarget?: unknown) => {
    const targetId = targetSchema.parse(rawTarget)
    const request = AiVaultSearchRequestSchema.parse(raw)
    return targetId
      ? remoteClient(targetId).searchSessions(request)
      : searchSessionService(request, 'ipc')
  })
  ipcMain.handle('aiVault:searchStatus', (_event, rawTarget?: unknown) => {
    const targetId = targetSchema.parse(rawTarget)
    return targetId ? remoteClient(targetId).searchStatus() : sessionSearchServiceStatus()
  })
}

function remoteClient(targetId: string): ReturnType<typeof createSessionSearchClient> {
  return createSessionSearchClient(
    (method, params) => requestActiveSshSessionSearch(targetId, method, params),
    'relay'
  )
}
