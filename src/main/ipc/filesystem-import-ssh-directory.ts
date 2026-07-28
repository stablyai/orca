import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'
import { assertSafeRemotePathSegment, type RemotePathFlavor } from '../ssh/ssh-remote-platform'
import {
  admitExternalImportTreeEntry,
  assertExternalImportTreeDepth,
  createExternalImportTreeBudget,
  type ExternalImportTreeBudget
} from './filesystem-external-import-limits'

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
  return preScanSshImportDirectoryWithinBudget(
    dirPath,
    remotePathFlavor,
    createExternalImportTreeBudget(),
    '',
    0
  )
}

async function preScanSshImportDirectoryWithinBudget(
  dirPath: string,
  remotePathFlavor: RemotePathFlavor,
  budget: ExternalImportTreeBudget,
  relativeDir: string,
  depth: number
): Promise<boolean> {
  assertExternalImportTreeDepth(depth)
  const directory = await opendir(dirPath)
  try {
    for await (const entry of directory) {
      assertSafeRemotePathSegment(entry.name, remotePathFlavor)
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      admitExternalImportTreeEntry(budget, relativePath, false)
      if (entry.isSymbolicLink()) {
        return true
      }
      if (
        entry.isDirectory() &&
        (await preScanSshImportDirectoryWithinBudget(
          join(dirPath, entry.name),
          remotePathFlavor,
          budget,
          relativePath,
          depth + 1
        ))
      ) {
        return true
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
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
  await uploadSshImportDirectoryWithinBudget(
    provider,
    uploadSession,
    localDir,
    remoteDir,
    rootRealPath,
    remotePathFlavor,
    createExternalImportTreeBudget(),
    '',
    0,
    assertCurrent
  )
}

async function uploadSshImportDirectoryWithinBudget(
  provider: IFilesystemProvider,
  uploadSession: FileUploadSession,
  localDir: string,
  remoteDir: string,
  rootRealPath: string,
  remotePathFlavor: RemotePathFlavor,
  budget: ExternalImportTreeBudget,
  relativeDir: string,
  depth: number,
  assertCurrent?: () => void
): Promise<void> {
  assertExternalImportTreeDepth(depth)
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  const directory = await opendir(localDir)
  try {
    for await (const entry of directory) {
      assertSafeRemotePathSegment(entry.name, remotePathFlavor)
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      admitExternalImportTreeEntry(budget, relativePath, false)
      const localPath = join(localDir, entry.name)
      const remotePath = `${remoteDir}/${entry.name}`
      await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
      const statResult = await lstat(localPath)

      // Why: the up-front scan cannot prevent a source swap during upload.
      if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
        continue
      }

      if (statResult.isDirectory()) {
        assertCurrent?.()
        await provider.createDirNoClobber(remotePath)
        await uploadSshImportDirectoryWithinBudget(
          provider,
          uploadSession,
          localPath,
          remotePath,
          rootRealPath,
          remotePathFlavor,
          budget,
          relativePath,
          depth + 1,
          assertCurrent
        )
        continue
      }
      assertCurrent?.()
      await uploadSession.uploadFile(localPath, remotePath, { exclusive: true })
    }
  } finally {
    await directory.close().catch(() => undefined)
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
