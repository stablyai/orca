import { lstat, realpath } from 'node:fs/promises'
import { shell } from 'electron'
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
import { isENOENT } from '../ipc/filesystem-path-containment'

// Trashes a validated session's paths, companions first so a part-way failure
// leaves the row on screen to retry from instead of stranding the rest on disk.
// Never throws: IPC payloads are untyped at runtime, so a bad input and an fs
// error both resolve to a discriminated result the handler can render.
export async function deleteAiVaultSessionFile(
  args: ValidateAiVaultSessionDeleteTargetArgs & { sessionId?: string }
): Promise<AiVaultDeleteSessionResult> {
  const validation = validateAiVaultSessionDeleteTarget(args)
  if (!validation.allowed) {
    return { outcome: 'rejected', agent: validation.agent, reason: validation.reason }
  }
  const { agent, removals } = validation

  try {
    for (const removal of removals) {
      const rejection = await removeOne(removal)
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

// Trash one planned path, or return the rejection code that stops the plan. A
// missing path is success everywhere: companions are optional (no subagents dir
// if none ever ran) and an externally-deleted transcript must stay idempotent.
async function removeOne(
  removal: AiVaultSessionDeleteRemoval
): Promise<'unexpected-target-kind' | 'path-outside-known-roots' | null> {
  // WSL validates and removes inside the distro because 9P stat is unreliable
  // and its virtual volume has no Recycle Bin for trashItem.
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
  // lstat (not stat) so a symlink is caught here rather than dereferenced.
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
  // Catches a symlinked parent that escapes the agent's roots, which lstat on
  // the leaf can't see. Roots are only resolve()'d, so realpath them too or a
  // session under a symlinked root (~/.claude -> /Volumes/data/.claude) is
  // falsely rejected; a root absent on this host falls back to its text form.
  if (realResolvedPath !== removal.path) {
    const realRoots = await Promise.all(
      removal.roots.map((root) => realpath(root).catch(() => root))
    )
    if (!realRoots.some((root) => isPathInsideOrEqual(root, realResolvedPath))) {
      return 'path-outside-known-roots'
    }
  }

  try {
    await shell.trashItem(removal.path)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  return null
}
