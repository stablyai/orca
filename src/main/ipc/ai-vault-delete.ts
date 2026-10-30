import { ipcMain, shell } from 'electron'
import {
  configureRemoteAiVaultSessionDelete,
  deleteHostAiVaultSession
} from '../ai-vault/host-session-delete'
import { parseRoutableExecutionHostId } from '../../shared/execution-host'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'

export type RuntimeAiVaultSessionDeleter = (
  environmentId: string,
  args: AiVaultDeleteSessionArgs
) => Promise<AiVaultDeleteSessionResult>

// Inject invalidation because ai-vault.ts owns the multi-host cache choice.
type AiVaultDeleteDeps = {
  invalidateMultiHostListCache: () => void
  invalidateBackgroundCache?: (paths: string[]) => Promise<void>
  deleteRuntimeSession?: RuntimeAiVaultSessionDeleter
}

let runtimeSessionDeleter: RuntimeAiVaultSessionDeleter | undefined

/** Main wires the saved-server transport here; without it a server-hosted row cannot be deleted. */
export function configureRuntimeAiVaultSessionDelete(
  deleter: RuntimeAiVaultSessionDeleter | undefined
): void {
  runtimeSessionDeleter = deleter
}

const moveToTrash = (removal: { path: string }): Promise<void> => shell.trashItem(removal.path)

export function registerAiVaultDeleteHandler(deps: AiVaultDeleteDeps): void {
  ipcMain.handle('aiVault:deleteSession', (_event, args?: AiVaultDeleteSessionArgs) =>
    deleteAiVaultSession(args, deps)
  )
  // A paired client deleting on this desktop gets the same Trash and cache fencing as a local delete.
  configureRemoteAiVaultSessionDelete({
    removePath: moveToTrash,
    invalidateMultiHostListCache: deps.invalidateMultiHostListCache,
    invalidateBackgroundCache: deps.invalidateBackgroundCache
  })
}

/** Delete on the session's own host: this computer's Trash, or the owning runtime's RPC. */
export async function deleteAiVaultSession(
  args: AiVaultDeleteSessionArgs | undefined,
  deps: AiVaultDeleteDeps
): Promise<AiVaultDeleteSessionResult> {
  const host = parseRoutableExecutionHostId(args?.executionHostId)
  if (args && host?.kind === 'runtime') {
    const deleteRuntimeSession = deps.deleteRuntimeSession ?? runtimeSessionDeleter
    if (!deleteRuntimeSession) {
      return { outcome: 'rejected', agent: args.agent, reason: 'non-local-host' }
    }
    const result = await deleteRuntimeSession(host.environmentId, args)
    if (result.outcome === 'deleted') {
      // Full invalidation also fences scans already in flight from re-caching the deleted row.
      deps.invalidateMultiHostListCache()
    }
    return result
  }
  return deleteHostAiVaultSession(args, {
    removePath: moveToTrash,
    invalidateMultiHostListCache: deps.invalidateMultiHostListCache,
    invalidateBackgroundCache: deps.invalidateBackgroundCache
  })
}
