import { randomUUID } from 'node:crypto'
import { lstat, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  FOLDER_PROJECT_SYNC_CAPABILITY,
  type FolderSyncEntry
} from '../../../shared/project/folder-project-sync'
import { getRepoMainWorktreeId } from '../../../shared/worktree/id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { isRuntimeEnvironmentManuallyDisconnected } from '../../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import {
  RUNTIME_UPLOAD_SLICE_BYTES,
  streamExternalFileSlices
} from '../../ipc/runtime-transfers/runtime-upload-file-stream'
import { REMOTE_IMPORT_MAX_FILE_BYTES } from '../../ipc/runtime-transfers/runtime-import-limits'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { FOLDER_SYNC_TEMP_PREFIX } from './folder-sync-manifest'
import { publishFolderSyncChange, type FolderSyncPublication } from './folder-sync-publication'

const FolderSyncServerStatus = z.object({
  runtimeId: z.string().min(1),
  capabilities: z.array(z.string()).optional()
})

const FolderSyncFileChunk = z.object({
  contentBase64: z.string(),
  bytesRead: z.number().int().nonnegative()
})

export type FolderSyncServer = {
  environmentId: string
  pairingRevision: number
  runtimeId: string
}

export class FolderSyncTransport {
  constructor(
    private readonly userDataPath: string,
    private readonly server: FolderSyncServer,
    private readonly signal: AbortSignal
  ) {}

  async call(method: string, params: unknown): Promise<unknown> {
    this.signal.throwIfAborted()
    if (isRuntimeEnvironmentManuallyDisconnected(this.server.environmentId)) {
      throw new Error('Server is disconnected.')
    }
    const response = await callRuntimeEnvironment(
      this.userDataPath,
      this.server.environmentId,
      method,
      params,
      30_000,
      this.server.pairingRevision,
      undefined,
      {
        expectedEnvironmentRuntimeId: this.server.runtimeId,
        signal: this.signal,
        preparation: { wslStart: 'never', background: true }
      }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }

  async apply(
    local: Repo,
    remote: Pick<Repo, 'id' | 'path'>,
    from: 0 | 1,
    publication: FolderSyncPublication
  ): Promise<void> {
    const worktree = `id:${getRepoMainWorktreeId(remote)}`
    const remoteTarget = { repoId: remote.id, expectedPath: remote.path, sourceRepoId: local.id }
    const stage =
      publication.entry?.kind === 'file' ? `${FOLDER_SYNC_TEMP_PREFIX}${randomUUID()}` : undefined
    try {
      if (stage && publication.entry?.kind === 'file') {
        await (from === 0
          ? this.upload(local.path, publication.path, publication.entry, worktree, stage)
          : this.download(local.path, publication.path, publication.entry, worktree, stage))
      }
      this.signal.throwIfAborted()
      await (from === 0
        ? this.call('projectHostSetup.publishFolderSyncChange', {
            ...remoteTarget,
            ...publication,
            stage
          })
        : publishFolderSyncChange(local.path, { ...publication, stage }))
    } catch (error) {
      if (stage) {
        await (
          from === 0
            ? this.call('files.delete', {
                worktree,
                relativePath: stage,
                expectedExecutionHostId: LOCAL_EXECUTION_HOST_ID
              })
            : rm(join(windowsFsPath(local.path), stage), { force: true })
        ).catch(() => {})
      }
      throw error
    }
  }

  private async upload(
    root: string,
    path: string,
    entry: Extract<FolderSyncEntry, { kind: 'file' }>,
    worktree: string,
    stage: string
  ): Promise<void> {
    const sourceRootPath = windowsFsPath(root)
    const stat = await lstat(join(sourceRootPath, path))
    if (stat.size !== entry.size) {
      throw new Error(`File changed during folder sync: ${path}`)
    }
    await streamExternalFileSlices({
      sourceRootPath,
      entryRelativePath: path,
      expected: {
        byteLength: stat.size,
        modifiedAtMs: stat.mtimeMs,
        inode: stat.ino,
        deviceId: stat.dev
      },
      maxFileBytes: REMOTE_IMPORT_MAX_FILE_BYTES,
      limitLabel: 'folder sync per-file limit',
      signal: this.signal,
      writeSlice: async (contentBase64, offset) => {
        await this.call('files.writeBase64Chunk', {
          worktree,
          relativePath: stage,
          contentBase64,
          append: offset > 0,
          expectedExecutionHostId: LOCAL_EXECUTION_HOST_ID
        })
      }
    })
  }

  private async download(
    root: string,
    path: string,
    entry: Extract<FolderSyncEntry, { kind: 'file' }>,
    worktree: string,
    stage: string
  ): Promise<void> {
    const file = await open(join(windowsFsPath(root), stage), 'wx', 0o600)
    try {
      for (let offset = 0; offset < entry.size;) {
        const chunk = FolderSyncFileChunk.parse(
          await this.call('files.readChunk', {
            worktree,
            relativePath: path,
            offset,
            length: Math.min(RUNTIME_UPLOAD_SLICE_BYTES, entry.size - offset)
          })
        )
        const bytes = Buffer.from(chunk.contentBase64, 'base64')
        if (
          !bytes.length ||
          bytes.length !== chunk.bytesRead ||
          offset + bytes.length > entry.size
        ) {
          throw new Error(`File changed during folder sync: ${path}`)
        }
        await file.writeFile(bytes)
        offset += bytes.length
      }
    } finally {
      await file.close()
    }
  }
}

export async function resolveFolderSyncServer(
  userDataPath: string,
  environmentId: string,
  signal: AbortSignal,
  expectedPairingRevision?: number
): Promise<FolderSyncServer> {
  const environment = await resolveEnvironment(userDataPath, environmentId)
  if (environment.id !== environmentId) {
    throw new Error('Invalid server ID.')
  }
  const pairingRevision =
    expectedPairingRevision ?? environment.pairingRevision ?? environment.createdAt
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'status.get',
    undefined,
    15_000,
    pairingRevision,
    undefined,
    { signal, preparation: { wslStart: 'never', background: true } }
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const status = FolderSyncServerStatus.parse(response.result)
  if (!status.capabilities?.includes(FOLDER_PROJECT_SYNC_CAPABILITY)) {
    throw new Error('Update Orca on this server to sync folders.')
  }
  return { environmentId, pairingRevision, runtimeId: status.runtimeId }
}
