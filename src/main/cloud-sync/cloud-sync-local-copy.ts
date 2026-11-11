// A workspace's copy on this computer as a whole: where it is (from the runtime record), what
// removing it would take with it, and removing it (archive, delete, both rows off).
import { rm, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import type { CloudSyncRemovalPreview } from '../../shared/cloud-sync/cloud-sync-contract'
import { localStatAt, removeCopies } from './cloud-sync-local-writes'
import { SYNC_TEMP_DIR, cloudSyncFolder, isContextPath } from './cloud-sync-paths'
import { isLocalCopyEdited } from './cloud-sync-plan'
import type { CloudSyncStore } from './cloud-sync-store'

export type CloudRuntime = {
  workspaceId: string
  environmentId: string
  folder: string
  projectRoot: string | null
  running: boolean
  /** Deleted (or being deleted) on this computer. */
  gone: boolean
}

export function cloudRuntimesFrom(
  runtimes: readonly EphemeralVmRuntimeRecord[],
  home?: string
): CloudRuntime[] {
  const out: CloudRuntime[] = []
  for (const runtime of runtimes) {
    if (runtime.recipe?.provider !== 'orca-cloud' || !runtime.workspaceId) {
      continue
    }
    let projectRoot: string | null = null
    if (runtime.recipeResult) {
      const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
      projectRoot = connection.type === 'orca-server' ? (connection.projectRoot ?? null) : null
    }
    out.push({
      workspaceId: runtime.workspaceId,
      environmentId: runtime.runtimeEnvironmentId ?? '',
      folder: cloudSyncFolder(
        {
          repoName: runtime.repoPath ? basename(runtime.repoPath) : undefined,
          workspaceName: runtime.workspaceName,
          workspaceId: runtime.workspaceId
        },
        home
      ),
      projectRoot,
      running: runtime.status === 'running' && Boolean(runtime.runtimeEnvironmentId),
      gone:
        runtime.status === 'cleaned' ||
        runtime.status === 'cleanup_pending' ||
        runtime.status === 'cleanup_failed'
    })
  }
  return out
}

/**
 * Removes what this computer copied (per its index) and the folders that leaves empty. Files
 * someone added here stay, and so does any folder that still holds them.
 */
export async function removeLocalCopy(
  store: CloudSyncStore,
  workspaceId: string,
  folder: string
): Promise<void> {
  const index = await store.readIndex(workspaceId, folder)
  await removeCopies(folder, Object.keys(index.entries), index.entries)
  await rm(join(folder, SYNC_TEMP_DIR), { recursive: true, force: true }).catch(() => undefined)
  await rmdir(join(folder, '.context')).catch(() => undefined)
  await rmdir(folder).catch(() => undefined)
  await rmdir(join(folder, '..')).catch(() => undefined)
  await store.removeIndex(workspaceId)
}

/** Mirror turned off while asleep: the mirrored files go now (they'd only get staler). */
export async function removeMirroredFiles(
  store: CloudSyncStore,
  workspaceId: string,
  folder: string
): Promise<void> {
  const index = await store.readIndex(workspaceId, folder)
  const outside = Object.keys(index.entries).filter((path) => !isContextPath(path))
  if (outside.length > 0) {
    await removeCopies(folder, outside, index.entries)
    await store.writeIndex(workspaceId, index)
  }
}

export async function previewRemoval(
  store: CloudSyncStore,
  workspaceId: string,
  folder: string
): Promise<CloudSyncRemovalPreview> {
  const index = await store.readIndex(workspaceId, folder)
  let editedHere = 0
  for (const [path, entry] of Object.entries(index.entries)) {
    const here = await localStatAt(folder, path)
    if (isLocalCopyEdited(entry, here)) {
      editedHere++
    }
  }
  return { hasLocalCopy: Object.keys(index.entries).length > 0, editedHere }
}
