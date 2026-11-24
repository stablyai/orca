import type { z } from 'zod'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  CreateFolderReplica,
  FolderReplica,
  PublishFolderSyncChange
} from '../../../../../shared/project/folder-project-sync'
import { scanFolderSyncManifest } from '../../../../workspaces/folder-sync/folder-sync-manifest'
import { publishFolderSyncChange } from '../../../../workspaces/folder-sync/folder-sync-publication'
import { defineMethod, type RpcContext } from '../../core'

function requireFolderReplica(
  runtime: RpcContext['runtime'],
  { repoId, sourceRepoId, expectedPath }: z.infer<typeof FolderReplica>
) {
  const repo = runtime
    .listVisibleRepos()
    .find(
      (row) =>
        row.id === repoId &&
        row.path === expectedPath &&
        row.folderProjectSourceId === sourceRepoId &&
        row.kind === 'folder' &&
        getRepoExecutionHostId(row) === LOCAL_EXECUTION_HOST_ID
    )
  if (!repo) {
    throw new Error('Folder project replica is no longer registered on this server.')
  }
  return repo
}

export const FOLDER_PROJECT_SYNC_METHODS = [
  defineMethod({
    name: 'projectHostSetup.createFolderReplica',
    permission: 'workspace',
    params: CreateFolderReplica,
    handler: async ({ sourceRepoId, name }, { runtime }) => {
      const existing = runtime
        .listVisibleRepos()
        .find(
          (repo) =>
            repo.kind === 'folder' &&
            repo.folderProjectSourceId === sourceRepoId &&
            getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
        )
      if (existing) {
        return { repo: existing }
      }
      const safeName = Array.from(name.trim(), (character) =>
        character.charCodeAt(0) < 32 || /[\\/:<>"|?*]/.test(character) ? '_' : character
      )
        .slice(0, 48)
        .join('')
      const result = await runtime.createRepo(
        runtime.getDefaultCreateProjectParent(),
        `${safeName || 'Folder'}-${sourceRepoId}`,
        'folder',
        { sourceRepoId, displayName: name }
      )
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result
    }
  }),
  defineMethod({
    name: 'projectHostSetup.folderReplicaManifest',
    permission: 'workspace',
    params: FolderReplica,
    handler: (params, { runtime, signal }) =>
      scanFolderSyncManifest(requireFolderReplica(runtime, params).path, signal)
  }),
  defineMethod({
    name: 'projectHostSetup.publishFolderSyncChange',
    permission: 'workspace',
    params: PublishFolderSyncChange,
    handler: async (params, { runtime }) => {
      await publishFolderSyncChange(requireFolderReplica(runtime, params).path, params)
      return { ok: true }
    }
  })
]
