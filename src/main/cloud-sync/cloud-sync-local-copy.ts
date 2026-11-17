// A workspace's copy on this computer as a whole: where it is (from the runtime record), what
// removing it would take with it, and removing it (archive, delete, sync turned off).
import { lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipes'
import type { CloudSyncRemovalPreview } from '../../shared/cloud-sync/cloud-sync-contract'
import { localStatAt, removeCopies } from './cloud-sync-local-writes'
import { SYNC_TEMP_DIR, cloudSyncFolder, legacyCloudSyncFolder } from './cloud-sync-paths'
import { isLocalCopyEdited } from './cloud-sync-plan'
import type { CloudSyncStore } from './cloud-sync-store'

export type CloudRuntime = {
  workspaceId: string
  environmentId: string
  folder: string
  /** Where builds before the id suffix kept this workspace's copy. */
  legacyFolder: string
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
    const names = {
      repoName: runtime.repoPath ? basename(runtime.repoPath) : undefined,
      workspaceName: runtime.workspaceName,
      workspaceId: runtime.workspaceId
    }
    out.push({
      workspaceId: runtime.workspaceId,
      environmentId: runtime.runtimeEnvironmentId ?? '',
      folder: cloudSyncFolder(names, home),
      legacyFolder: legacyCloudSyncFolder(names, home),
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
 * Moves a copy made under the old folder name into the workspace's own folder, so nothing is
 * copied again and edits made here stay. An old folder another workspace also maps to is left as
 * it is: whose files are whose there is unknown, so nothing in it is moved or removed, and each
 * workspace starts a fresh copy in its own folder.
 */
export async function adoptLegacyFolder(
  store: CloudSyncStore,
  runtime: CloudRuntime,
  runtimes: readonly CloudRuntime[]
): Promise<void> {
  if ((await store.indexFolder(runtime.workspaceId)) !== runtime.legacyFolder) {
    return
  }
  const shared = runtimes.some(
    (other) =>
      other.workspaceId !== runtime.workspaceId && other.legacyFolder === runtime.legacyFolder
  )
  if (shared || (await lstat(runtime.folder).catch(() => null)) !== null) {
    return
  }
  const index = await store.readIndex(runtime.workspaceId, runtime.legacyFolder)
  await mkdir(dirname(runtime.folder), { recursive: true })
  await rename(runtime.legacyFolder, runtime.folder)
  await store.writeIndex(runtime.workspaceId, { ...index, folder: runtime.folder })
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
