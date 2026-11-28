import { randomUUID } from 'node:crypto'
import { link, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { isENOENT } from '../../../filesystem/local-file-io/filesystem-path-containment'

export function decodeDownloadedFileContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
}

export function createSiblingTransferPath(destinationPath: string, suffix: string): string {
  // Keep staging beside destination so promotion rename stays on one volume.
  return join(dirname(destinationPath), `.${randomUUID()}.${suffix}`)
}

export async function cleanupLocalTransferPath(filePath: string | null): Promise<void> {
  if (!filePath) {
    return
  }
  await rm(filePath, { force: true }).catch(() => {})
}

export async function inspectDownloadDestination(
  destinationPath: string
): Promise<{ existed: boolean }> {
  try {
    const destinationStat = await stat(destinationPath)
    if (destinationStat.isDirectory()) {
      throw new Error('Cannot download to a directory')
    }
    return { existed: true }
  } catch (error) {
    if (isENOENT(error)) {
      return { existed: false }
    }
    throw error
  }
}

export async function assertDestinationStillUnclaimed(destinationPath: string): Promise<void> {
  try {
    await stat(destinationPath)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  throw new Error('Destination file appeared before download completed')
}

export async function promoteDownloadedFile(
  tempPath: string,
  destinationPath: string,
  destinationExisted: boolean
): Promise<void> {
  if (!destinationExisted) {
    await assertDestinationStillUnclaimed(destinationPath)
    await rename(tempPath, destinationPath)
    return
  }

  const backupPath = createSiblingTransferPath(destinationPath, 'backup')
  let backupCreated = false
  try {
    await rename(destinationPath, backupPath)
    backupCreated = true
    await rename(tempPath, destinationPath)
    await cleanupLocalTransferPath(backupPath)
  } catch (error) {
    if (backupCreated) {
      await rename(backupPath, destinationPath).catch(() => {})
    }
    throw error
  }
}

const COPY_FALLBACK_CHUNK_BYTES = 1024 * 1024
// Volumes without hard links (FAT, exFAT, some network shares).
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/**
 * Moves the finished file to the first name nothing holds, never replacing a file: a link (or, on
 * a volume without links, an exclusive create that the file is then copied into) fails when the
 * name was taken while it downloaded, and the next free name is tried. `signal` is checked only
 * before a name is claimed; once a copy into a new file starts, it runs to the end.
 */
export async function promoteDownloadedFileWithoutOverwrite(
  tempPath: string,
  destinationPath: string,
  nextFreePath: () => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  let target = destinationPath
  let hardLinks = true
  for (let attempt = 0; attempt < 8; attempt += 1) {
    signal?.throwIfAborted()
    try {
      await (hardLinks ? link(tempPath, target) : copyIntoNewFile(tempPath, target))
      await cleanupLocalTransferPath(tempPath)
      return target
    } catch (error) {
      const code = errnoCodeOrUnknown(error)
      if (code === 'EEXIST') {
        target = await nextFreePath()
      } else if (hardLinks && NO_HARD_LINK_CODES.has(code)) {
        hardLinks = false
      } else {
        throw error
      }
    }
  }
  throw new Error('Could not choose a unique file name in Downloads.')
}

/**
 * Writes through the handle that created the file, so nothing another app saves there is touched.
 * Once created, the file is never removed or renamed here, even when the copy fails: Node can't
 * remove a file by its handle, and removing it by name could take a file another app saved under
 * that name in between. A failed copy says where it stopped and that an incomplete file may be
 * left there; it can't say more, since another app may have replaced or removed that name since.
 *
 * Errors: the first failure reading the staged copy or writing the new file is the one reported;
 * the new file is always closed, and its close failing (a lost write) is reported when nothing
 * failed before. Closing the read-only staged copy is best effort: nothing it wrote can be lost.
 */
async function copyIntoNewFile(sourcePath: string, targetPath: string): Promise<void> {
  const target = await open(targetPath, 'wx')
  let failed = false
  let failure: unknown = null
  let source: FileHandle | null = null
  try {
    source = await open(sourcePath, 'r')
    const buffer = Buffer.alloc(COPY_FALLBACK_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) {
        break
      }
      for (let written = 0; written < bytesRead;) {
        written += (await target.write(buffer, written, bytesRead - written)).bytesWritten
      }
    }
  } catch (error) {
    failed = true
    failure = error
  }
  await source?.close().catch(() => {})
  // Network shares and full disks can report a lost write only when the file closes.
  await target.close().catch((error: unknown) => {
    if (!failed) {
      failed = true
      failure = error
    }
  })
  if (failed) {
    const reason = failure instanceof Error ? failure.message : String(failure)
    throw new Error(
      `Saving to ${targetPath} stopped partway (${reason}). An incomplete file may be left there.`,
      { cause: failure }
    )
  }
}

export type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

export const DOWNLOAD_SESSION_TTL_MS = 30 * 60 * 1000
