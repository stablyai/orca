import { rm } from 'node:fs/promises'
import { getAiVaultWslHomeDirs, invalidateAiVaultSessionListCache } from './cached-session-list'
import { deleteAiVaultSessionFile, type AiVaultSessionPathRemover } from './session-delete'
import { invalidateSessionParseCacheEntry } from './session-scanner-parse-cache'
import { invalidateAiVaultBackgroundCache } from './session-scanner-background'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'

export type HostAiVaultSessionDeleteDeps = {
  removePath: AiVaultSessionPathRemover
  invalidateMultiHostListCache?: () => void
  invalidateBackgroundCache?: (paths: string[]) => Promise<void>
}

/** Plain-Node hosts have no Trash, so a remote delete removes the files outright. */
export const removeAiVaultSessionPathPermanently: AiVaultSessionPathRemover = (removal) =>
  rm(removal.path, { recursive: removal.kind === 'directory', force: true })

let remoteDeleteDeps: HostAiVaultSessionDeleteDeps = {
  removePath: removeAiVaultSessionPathPermanently
}

/** An Electron host swaps in its Trash and its own multi-host cache; orcad keeps the default. */
export function configureRemoteAiVaultSessionDelete(deps: HostAiVaultSessionDeleteDeps): void {
  remoteDeleteDeps = deps
}

/** A paired client's delete: never trust its host stamp, only this host's own files. */
export function deleteAiVaultSessionForRemoteClient(
  args: Omit<AiVaultDeleteSessionArgs, 'executionHostId'>
): Promise<AiVaultDeleteSessionResult> {
  return deleteHostAiVaultSession(
    { ...args, executionHostId: LOCAL_EXECUTION_HOST_ID },
    remoteDeleteDeps
  )
}

/** Validate against this host's roots, delete, then invalidate caches so the row cannot resurrect. */
export async function deleteHostAiVaultSession(
  args: AiVaultDeleteSessionArgs | undefined,
  deps: HostAiVaultSessionDeleteDeps
): Promise<AiVaultDeleteSessionResult> {
  // Default absent payload fields because the validator destructures its input.
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const result = await deleteAiVaultSessionFile(
    {
      // SAFETY: the validator rejects any agent outside the deletable list.
      agent: args?.agent as AiVaultAgent,
      sessionId: args?.sessionId,
      filePath: args?.filePath ?? '',
      executionHostId: args?.executionHostId,
      wslHomeDirs
    },
    deps.removePath
  )

  if (result.outcome === 'deleted') {
    // Invalidate desktop, shared runtime/mobile and raw-path parse caches to prevent resurrection.
    deps.invalidateMultiHostListCache?.()
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
