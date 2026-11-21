import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAiVaultWslHomeDirs } from '../discovery/ai-vault-scan-roots'
import { invalidateAiVaultSessionListCache } from '../listing/cached-session-list'
import { deleteAiVaultSessionFile, type AiVaultSessionPathRemover } from './session-delete'
import { invalidateSessionParseCacheEntry } from '../parse-cache/session-parse-cache-store'
import { invalidateAiVaultBackgroundCache } from '../scan-service/session-scanner-background'
import type { AiVaultAgent } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'

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
    const filePaths = [...new Set([args?.filePath ?? '', ...(result.filePaths ?? [])])]
    for (const filePath of filePaths) {
      invalidateSessionParseCacheEntry(filePath)
    }
    await (deps.invalidateBackgroundCache ?? invalidateAiVaultBackgroundCache)(filePaths).catch(
      (error) => {
        console.warn('[ai-vault] background cache invalidation failed:', error)
      }
    )
  }

  return result
}

/** Bytes a removal frees; symlinks count as themselves, never their targets. */
async function measurePathBytes(path: string): Promise<number> {
  const stats = await lstat(path).catch(() => null)
  if (!stats?.isDirectory()) {
    return stats?.size ?? 0
  }
  const entries = await readdir(path).catch(() => [])
  let total = 0
  for (const entry of entries) {
    total += await measurePathBytes(join(path, entry))
  }
  return total
}

/** Cleanup deletes for good: the Trash would keep the space it is meant to free. Caches clear once. */
export async function deleteHostAiVaultSessionsPermanently(
  targets: readonly { agent: AiVaultAgent; filePath: string }[],
  /** Asked right before each removal; false keeps that session (neither deleted nor failed). */
  shouldDelete: (target: {
    agent: AiVaultAgent
    filePath: string
  }) => Promise<boolean> = async () => true
): Promise<{ deleted: number; failed: number; freedBytes: number }> {
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const deletedPaths: string[] = []
  let failed = 0
  let freedBytes = 0
  // Measured per validated removal, so companion folders count and a refused removal doesn't.
  const removeAndMeasure: AiVaultSessionPathRemover = async (removal) => {
    const sizeBytes = await measurePathBytes(removal.path)
    await removeAiVaultSessionPathPermanently(removal)
    freedBytes += sizeBytes
  }
  for (const target of targets) {
    if (!(await shouldDelete(target))) {
      continue
    }
    const result = await deleteAiVaultSessionFile(
      { ...target, executionHostId: LOCAL_EXECUTION_HOST_ID, wslHomeDirs },
      removeAndMeasure
    )
    if (result.outcome === 'deleted') {
      deletedPaths.push(target.filePath)
    } else {
      failed += 1
    }
  }
  await invalidateDeletedAiVaultSessionPaths(deletedPaths)
  return { deleted: deletedPaths.length, failed, freedBytes }
}

/** After a permanent delete: every list and parse cache, so deleted rows cannot resurrect. */
export async function invalidateDeletedAiVaultSessionPaths(
  deletedPaths: readonly string[]
): Promise<void> {
  if (deletedPaths.length === 0) {
    return
  }
  remoteDeleteDeps.invalidateMultiHostListCache?.()
  invalidateAiVaultSessionListCache()
  for (const path of deletedPaths) {
    invalidateSessionParseCacheEntry(path)
  }
  await (remoteDeleteDeps.invalidateBackgroundCache ?? invalidateAiVaultBackgroundCache)([
    ...deletedPaths
  ]).catch((error) => {
    console.warn('[ai-vault] background cache invalidation failed:', error)
  })
}
