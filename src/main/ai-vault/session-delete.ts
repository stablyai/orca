import { lstat, realpath } from 'node:fs/promises'
import type {
  AiVaultDeleteSessionResult,
  AiVaultSessionDeleteRemoval
} from '../../shared/ai-vault-session-deletion'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  validateAiVaultSessionDeleteTarget,
  type ValidateAiVaultSessionDeleteTargetArgs
} from './session-delete-target'
import { tryDeleteWslUncPath, WslDeleteValidationError } from '../wsl-unc-delete'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'

/** Desktop moves to Trash; a plain-Node host has none, so it removes permanently after the user confirmed. */
export type AiVaultSessionPathRemover = (removal: AiVaultSessionDeleteRemoval) => Promise<void>

// Remove companions first so partial failure leaves the transcript visible for retry.
export async function deleteAiVaultSessionFile(
  args: ValidateAiVaultSessionDeleteTargetArgs & { sessionId?: string },
  removePath: AiVaultSessionPathRemover
): Promise<AiVaultDeleteSessionResult> {
  const validation = validateAiVaultSessionDeleteTarget(args)
  if (!validation.allowed) {
    return { outcome: 'rejected', agent: validation.agent, reason: validation.reason }
  }
  const { agent, removals } = validation

  try {
    for (const removal of removals) {
      const rejection = await removeOne(removal, removePath)
      if (rejection) {
        return { outcome: 'rejected', agent, reason: rejection }
      }
    }
    return { outcome: 'deleted' }
  } catch (error) {
    return {
      outcome: 'failed',
      agent,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// Missing companions or externally removed transcripts are successful, idempotent removals.
async function removeOne(
  removal: AiVaultSessionDeleteRemoval,
  removePath: AiVaultSessionPathRemover
): Promise<'unexpected-target-kind' | 'path-outside-known-roots' | null> {
  // Remove inside WSL: 9P stats are unreliable and UNC volumes have no Recycle Bin.
  try {
    if (
      await tryDeleteWslUncPath(removal.path, {
        recursive: removal.kind === 'directory',
        approvedRoots: removal.roots
      })
    ) {
      return null
    }
  } catch (error) {
    if (error instanceof WslDeleteValidationError) {
      return error.reason
    }
    throw error
  }

  let stats
  try {
    stats = await lstat(removal.path)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  // lstat rejects symlink leaves without dereferencing them.
  const kindMatches = removal.kind === 'file' ? stats.isFile() : stats.isDirectory()
  if (!kindMatches) {
    return 'unexpected-target-kind'
  }

  let realResolvedPath: string
  try {
    realResolvedPath = await realpath(removal.path)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  // Resolve parents and roots to catch symlink escapes while allowing symlinked session roots.
  if (realResolvedPath !== removal.path) {
    const realRoots = await Promise.all(
      removal.roots.map((root) => realpath(root).catch(() => root))
    )
    if (!realRoots.some((root) => isPathInsideOrEqual(root, realResolvedPath))) {
      return 'path-outside-known-roots'
    }
  }

  try {
    await removePath(removal)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  return null
}
