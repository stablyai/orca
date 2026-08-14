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

// Which cache backs the multi-host list is ai-vault.ts's concern, so its
// invalidation is injected rather than reached into from here.
type AiVaultDeleteDeps = {
  invalidateMultiHostListCache: () => void
  invalidateBackgroundCache?: (paths: string[]) => Promise<void>
}

// Binds the delete orchestration to the caller's cache-invalidation seam.
export function registerAiVaultDeleteHandler(deps: AiVaultDeleteDeps): void {
  ipcMain.handle('aiVault:deleteSession', (_event, args?: AiVaultDeleteSessionArgs) =>
    deleteAiVaultSession(args, deps)
  )
}

// Adapts the untyped IPC payload for the executor (which owns re-validation and
// the trash), then invalidates on a real delete — otherwise the caches keep
// serving the deleted session for up to the scan TTL.
export async function deleteAiVaultSession(
  args: AiVaultDeleteSessionArgs | undefined,
  deps: AiVaultDeleteDeps
): Promise<AiVaultDeleteSessionResult> {
  // The validator tolerates a malformed agent/filePath but destructures `args`,
  // so an absent payload is defaulted here to keep the never-throws boundary.
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const result = await deleteAiVaultSessionFile({
    agent: args?.agent as AiVaultAgent,
    sessionId: args?.sessionId,
    filePath: args?.filePath ?? '',
    executionHostId: args?.executionHostId,
    wslHomeDirs
  })

  if (result.outcome === 'deleted') {
    // Three caches could otherwise resurrect it: the desktop per-host leg
    // cache, the shared local-scope cache (also the runtime/mobile path), and
    // this file's parse-cache entry.
    deps.invalidateMultiHostListCache()
    invalidateAiVaultSessionListCache()
    // The parse cache is keyed by the raw path the scanner discovered (which is
    // what the renderer echoes back as filePath), so invalidate with that exact
    // key — resolve() could normalise it away from the stored key and miss.
    invalidateSessionParseCacheEntry(args?.filePath ?? '')
    await (deps.invalidateBackgroundCache ?? invalidateAiVaultBackgroundCache)([
      args?.filePath ?? ''
    ]).catch((error) => {
      console.warn('[ai-vault] background cache invalidation failed:', error)
    })
  }

  return result
}
