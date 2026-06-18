import { ipcMain } from 'electron'
import { join } from 'path'
import { scanAiVaultSessions } from '../ai-vault/session-scanner'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'

const AI_VAULT_CACHE_TTL_MS = 15_000

type AiVaultHandlerOptions = {
  getAdditionalCodexHomePaths?: () => readonly string[]
}

type CachedAiVaultList = {
  key: string
  result: AiVaultListResult
  expiresAt: number
}

let cachedList: CachedAiVaultList | null = null
let inflightList: Promise<AiVaultListResult> | null = null
let inflightKey: string | null = null
let handlerOptions: AiVaultHandlerOptions = {}

async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const key = String(args?.limit ?? 'default')
  const now = Date.now()
  // Why: opening this panel repeatedly should not re-parse hundreds of JSONL
  // transcripts; explicit refreshes bypass the cache but not an active scan.
  if (args?.force !== true && cachedList?.key === key && cachedList.expiresAt > now) {
    return cachedList.result
  }
  if (inflightList && inflightKey === key) {
    return inflightList
  }

  inflightKey = key
  const additionalCodexSessionsDirs =
    handlerOptions.getAdditionalCodexHomePaths?.().map((homePath) => join(homePath, 'sessions')) ??
    []
  inflightList = scanAiVaultSessions({ limit: args?.limit, additionalCodexSessionsDirs })
    .then((result) => {
      cachedList = {
        key,
        result,
        expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
      }
      return result
    })
    .finally(() => {
      inflightKey = null
      inflightList = null
    })
  return inflightList
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  ipcMain.handle('aiVault:listSessions', (_event, args?: AiVaultListArgs) =>
    listAiVaultSessions(args)
  )
}
