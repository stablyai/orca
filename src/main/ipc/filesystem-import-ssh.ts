import { basename, posix, resolve } from 'node:path'
import { classifyImportSource } from './filesystem-import-source-stat'
import { deconflictCopyName } from '../../shared/import-copy-name'
import { getSshConnectionManager } from '../ssh/ssh-target-registry'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'
import type { ImportItemResult } from '../../shared/filesystem-import-result-types'
import { assertSafeRemotePathSegment, type RemotePathFlavor } from '../ssh/ssh-remote-platform'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { remotePathExists } from './filesystem-import-ssh-remote-existence'
import {
  captureLocalUploadRoot,
  preScanSshImportDirectory,
  uploadSshImportDirectory
} from './filesystem-import-ssh-directory'
import { errorMessage } from '../../shared/error-message'

// Why: the SSH import path uses SshFilesystemProvider instead of direct SFTP so
// system-SSH transports (ProxyCommand/ProxyJump/FIDO2) get the same workflows.
export async function importExternalPathsSsh(
  sourcePaths: string[],
  destDir: string,
  connectionId: string,
  options?: { ensureDir?: boolean; assertCurrent?: () => void }
): Promise<{ results: ImportItemResult[] }> {
  if (sourcePaths.length === 0) {
    return { results: [] }
  }

  const connManager = getSshConnectionManager()
  const conn = connManager?.getConnection(connectionId)
  if (!conn) {
    throw new Error(`No SSH connection for "${connectionId}"`)
  }

  const state = conn.getState()
  if (state.status !== 'connected') {
    if (state.status === 'reconnecting') {
      throw new Error('SSH connection is reconnecting — please try again in a moment')
    }
    throw new Error('SSH connection is not active — please reconnect and try again')
  }

  const provider = requireSshFilesystemProvider(connectionId)

  if (options?.ensureDir) {
    // Why: terminal-drop staging needs `${worktree}/.orca/drops` to exist
    // before the first upload. .orca/ is reserved as Orca-owned remote state;
    // see docs/terminal-drop-ssh.md.
    await ensureDropStagingDir(provider, destDir, options.assertCurrent)
  }

  const results: ImportItemResult[] = []
  const reservedNames = new Set<string>()
  if (!provider.openFileUploadSession) {
    throw new Error('Remote file upload is unavailable. Reconnect the SSH target and retry.')
  }
  options?.assertCurrent?.()
  const uploadSession = await provider.openFileUploadSession()
  // Why: filename legality follows the remote filesystem, not the client's OS.
  const remotePathFlavor: RemotePathFlavor = isWindowsAbsolutePathLike(destDir)
    ? 'windows'
    : 'posix'
  try {
    for (const sourcePath of sourcePaths) {
      const result = await importOneSourceSsh(
        provider,
        uploadSession,
        sourcePath,
        destDir,
        reservedNames,
        remotePathFlavor,
        options?.assertCurrent
      )
      results.push(result)
      if (result.status === 'imported') {
        // Why: destPath is a remote POSIX path (e.g. /home/user/foo/bar.txt).
        // Node's basename() uses the OS separator, which on Windows would
        // return the entire string instead of just the filename.
        reservedNames.add(posix.basename(result.destPath))
      }
    }
  } finally {
    uploadSession.close()
  }

  return { results }
}

async function importOneSourceSsh(
  provider: IFilesystemProvider,
  uploadSession: FileUploadSession,
  sourcePath: string,
  destDir: string,
  reservedNames: Set<string>,
  remotePathFlavor: RemotePathFlavor,
  assertCurrent?: () => void
): Promise<ImportItemResult> {
  const resolvedSource = resolve(sourcePath)

  const originalName = basename(resolvedSource)
  try {
    assertSafeRemotePathSegment(originalName, remotePathFlavor)
  } catch (error) {
    return {
      sourcePath,
      status: 'failed',
      reason: errorMessage(error)
    }
  }

  const classified = await classifyImportSource(sourcePath, resolvedSource)
  if ('rejection' in classified) {
    return classified.rejection
  }
  const sourceStat = classified.stat
  const isDir = sourceStat.isDirectory()

  let createdDestDir: string | null = null
  try {
    const rootRealPath = isDir ? await captureLocalUploadRoot(resolvedSource, sourceStat) : null
    if (isDir && (await preScanSshImportDirectory(resolvedSource, remotePathFlavor))) {
      return { sourcePath, status: 'skipped', reason: 'symlink' }
    }

    // Why: local inspection can outlive a HUB SSH session; revalidate before the first remote write.
    assertCurrent?.()
    const finalName = await deconflictCopyName(originalName, async (n) => {
      assertCurrent?.()
      return (await remotePathExists(provider, `${destDir}/${n}`)) || reservedNames.has(n)
    })
    const destPath = `${destDir}/${finalName}`
    const renamed = finalName !== originalName

    if (isDir) {
      assertCurrent?.()
      await provider.createDirNoClobber(destPath)
      createdDestDir = destPath
      await uploadSshImportDirectory(
        provider,
        uploadSession,
        resolvedSource,
        destPath,
        rootRealPath!,
        remotePathFlavor,
        assertCurrent
      )
    } else {
      assertCurrent?.()
      await uploadSession.uploadFile(resolvedSource, destPath, { exclusive: true })
    }

    return {
      sourcePath,
      status: 'imported',
      destPath,
      kind: isDir ? 'directory' : 'file',
      renamed
    }
  } catch (error) {
    if (createdDestDir) {
      // Why: local directory imports roll back partial output; SSH imports
      // should not leave the no-clobber root after a nested upload failure.
      try {
        assertCurrent?.()
        await provider.deletePath(createdDestDir, true)
      } catch {
        // Best effort; a replacement session must never inherit cleanup from the retired owner.
      }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: errorMessage(error)
    }
  }
}

async function ensureDropStagingDir(
  provider: IFilesystemProvider,
  destDir: string,
  assertCurrent?: () => void
): Promise<void> {
  const parent = posix.dirname(destDir)
  assertCurrent?.()
  await provider.createDir(parent)
  const gitignorePath = `${parent}/.gitignore`
  assertCurrent?.()
  if (!(await remotePathExists(provider, gitignorePath))) {
    assertCurrent?.()
    await provider.writeFile(gitignorePath, '*\n!.gitignore\n')
  }
  assertCurrent?.()
  await provider.createDir(destDir)
}
