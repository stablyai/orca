import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'
import { assertSafeRemotePathSegment, type RemotePathFlavor } from '../ssh/ssh-remote-platform'

export async function captureLocalUploadRoot(
  sourcePath: string,
  sourceStat: Awaited<ReturnType<typeof lstat>>
): Promise<string> {
  const rootRealPath = await realpath(sourcePath)
  const rootRealStat = await lstat(rootRealPath)
  if (
    statIdentityPartChanged(sourceStat.ino, rootRealStat.ino) ||
    statIdentityPartChanged(sourceStat.dev, rootRealStat.dev) ||
    !rootRealStat.isDirectory()
  ) {
    throw new Error(`Upload source changed while being inspected: ${sourcePath}`)
  }
  return rootRealPath
}

export async function preScanSshImportDirectory(
  dirPath: string,
  remotePathFlavor: RemotePathFlavor
): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    assertSafeRemotePathSegment(entry.name, remotePathFlavor)
    if (entry.isSymbolicLink()) {
      return true
    }
    if (entry.isDirectory()) {
      const childPath = join(dirPath, entry.name)
      if (await preScanSshImportDirectory(childPath, remotePathFlavor)) {
        return true
      }
    }
  }
  return false
}

export async function uploadSshImportDirectory(
  provider: IFilesystemProvider,
  uploadSession: FileUploadSession,
  localDir: string,
  remoteDir: string,
  rootRealPath: string,
  remotePathFlavor: RemotePathFlavor,
  assertCurrent?: () => void
): Promise<void> {
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  const entries = await readdir(localDir, { withFileTypes: true })
  for (const entry of entries) {
    assertSafeRemotePathSegment(entry.name, remotePathFlavor)
    const localPath = join(localDir, entry.name)
    const remotePath = `${remoteDir}/${entry.name}`
    await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
    const statResult = await lstat(localPath)

    // Why: skip symlinks and special files even after the up-front pre-scan;
    // this closes the TOCTOU gap if one is created during upload.
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }

    if (statResult.isDirectory()) {
      assertCurrent?.()
      await provider.createDirNoClobber(remotePath)
      await uploadSshImportDirectory(
        provider,
        uploadSession,
        localPath,
        remotePath,
        rootRealPath,
        remotePathFlavor,
        assertCurrent
      )
      continue
    }
    assertCurrent?.()
    await uploadSession.uploadFile(localPath, remotePath, { exclusive: true })
  }
}

function statIdentityPartChanged(
  left: number | bigint | undefined,
  right: number | bigint | undefined
): boolean {
  const leftKnown = left !== undefined && left !== 0 && left !== 0n
  const rightKnown = right !== undefined && right !== 0 && right !== 0n
  return leftKnown && rightKnown && left !== right
}

async function assertLocalUploadPathInsideRoot(
  rootRealPath: string,
  candidatePath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Upload source escapes selected directory: ${candidatePath}`)
  }
}
