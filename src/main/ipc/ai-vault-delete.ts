import { ipcMain } from 'electron'
import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSessionFile } from '../ai-vault/session-delete'
import { invalidateSessionParseCacheEntry } from '../ai-vault/session-scanner-parse-cache'
import { invalidateAiVaultBackgroundCache } from '../ai-vault/session-scanner-background'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'

// Inject invalidation because ai-vault.ts owns the multi-host cache choice.
type AiVaultDeleteDeps = {
  invalidateMultiHostListCache: () => void
  invalidateBackgroundCache?: (paths: string[]) => Promise<void>
}

export function registerAiVaultDeleteHandler(deps: AiVaultDeleteDeps): void {
  ipcMain.handle('aiVault:deleteSession', (_event, args?: AiVaultDeleteSessionArgs) =>
    deleteAiVaultSession(args, deps)
  )
}

/** Adapt IPC input for the validating executor and invalidate caches only after deletion. */
export async function deleteAiVaultSession(
  args: AiVaultDeleteSessionArgs | undefined,
  deps: AiVaultDeleteDeps
): Promise<AiVaultDeleteSessionResult> {
  // Default absent payload fields because the validator destructures its input.
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const result = await deleteAiVaultSessionFile({
    agent: args?.agent as AiVaultAgent,
    sessionId: args?.sessionId,
    filePath: args?.filePath ?? '',
    executionHostId: args?.executionHostId,
    wslHomeDirs
  })

  if (result.outcome === 'deleted') {
    // Invalidate desktop, shared runtime/mobile and raw-path parse caches to prevent resurrection.
    deps.invalidateMultiHostListCache()
    invalidateAiVaultSessionListCache()
    // Use the scanner's raw key; path normalization could miss its parse-cache entry.
    invalidateSessionParseCacheEntry(args?.filePath ?? '')
    await (deps.invalidateBackgroundCache ?? invalidateAiVaultBackgroundCache)([
      args?.filePath ?? ''
    ]).catch((error) => {
      console.warn('[ai-vault] background cache invalidation failed:', error)
    })
  }

  return result
}
