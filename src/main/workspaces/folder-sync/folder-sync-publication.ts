import { randomUUID } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FolderSyncEntry } from '../../../shared/project/folder-project-sync'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import { replaceLocalFileBytesIfUnchanged } from '../../filesystem/local-file-io/local-disk-bytes-replace'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import {
  FOLDER_SYNC_TEMP_PREFIX,
  fingerprintFolderSyncFile,
  isFolderSyncName
} from './folder-sync-manifest'

export type FolderSyncPublication = {
  path: string
  entry?: FolderSyncEntry
  previous?: FolderSyncEntry
  stage?: string
}

export async function publishFolderSyncChange(
  rootPath: string,
  { path, entry, previous, stage }: FolderSyncPublication
): Promise<void> {
  if (
    !path.split('/').every(isFolderSyncName) ||
    (stage !== undefined && !new RegExp(`^${FOLDER_SYNC_TEMP_PREFIX}[a-f0-9-]{36}$`).test(stage))
  ) {
    throw new Error('Invalid folder sync path.')
  }
  const root = await realpath(windowsFsPath(rootPath))
  const target = join(root, path)
  const stagedPath = stage === undefined ? undefined : join(root, stage)
  try {
    if ((await realpath(dirname(target))) !== dirname(target)) {
      throw new Error(`Folder sync path changed: ${path}`)
    }
    const current = await lstat(target).catch((error: unknown) => {
      if (isENOENT(error)) {
        return null
      }
      throw error
    })
    if (entry?.kind === 'directory' && !current) {
      await mkdir(target)
      return
    }
    if (!entry && previous?.kind === 'directory' && current?.isDirectory()) {
      await rmdir(target)
      return
    }
    if (entry?.kind === 'file' && stagedPath && stage) {
      const staged = await fingerprintFolderSyncFile(root, stage)
      if (staged.hash !== entry.hash || staged.size !== entry.size) {
        throw new Error(`File changed during folder sync: ${path}`)
      }
      if (!previous && !current) {
        await chmod(stagedPath, entry.executable ? 0o700 : 0o600)
        await link(stagedPath, target)
        return
      }
      if (previous?.kind === 'file' && current?.isFile()) {
        const result = await replaceLocalFileBytesIfUnchanged(
          target,
          (temp) => copyFile(stagedPath, temp),
          { expectedSha256: previous.hash }
        )
        if (result.ok) {
          return
        }
      }
    }
    // Removing a directory is non-recursive, and removing a file requires the observed bytes.
    if (!entry && previous?.kind === 'file' && current?.isFile()) {
      await removeFileIfUnchanged(root, target, previous.hash)
      return
    }
    throw new Error(`Folder sync destination changed: ${path}`)
  } finally {
    if (stagedPath) {
      await rm(stagedPath, { force: true })
    }
  }
}

async function removeFileIfUnchanged(
  root: string,
  target: string,
  previousHash: string
): Promise<void> {
  const hold = `${FOLDER_SYNC_TEMP_PREFIX}${randomUUID()}`
  const heldPath = join(root, hold)
  await rename(target, heldPath)
  try {
    if ((await fingerprintFolderSyncFile(root, hold)).hash !== previousHash) {
      throw new Error('The file changed while syncing its removal.')
    }
  } catch (error) {
    // Restore without overwriting a file created at the original path during the move.
    await link(heldPath, target).catch(() =>
      link(heldPath, `${target}.orca-sync-conflict-${randomUUID()}`)
    )
    await rm(heldPath)
    throw error
  }
  await rm(heldPath)
}
