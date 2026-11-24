import { randomUUID } from 'node:crypto'
import { link, open, rename, rm, stat } from 'node:fs/promises'
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

// Volumes without hard links (FAT, exFAT, some network shares).
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/**
 * Moves the finished file to the first name nothing holds, never replacing a file: a link (or, on
 * a volume without links, an exclusively created placeholder it then replaces) fails when the name
 * was taken while it downloaded, and the next free name is tried.
 */
export async function promoteDownloadedFileWithoutOverwrite(
  tempPath: string,
  destinationPath: string,
  nextFreePath: () => Promise<string>
): Promise<string> {
  let target = destinationPath
  let hardLinks = true
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      if (hardLinks) {
        await link(tempPath, target)
        await cleanupLocalTransferPath(tempPath)
      } else {
        await (await open(target, 'wx')).close()
        // The placeholder is ours, so a failed move leaves no empty file behind.
        await rename(tempPath, target).catch(async (error: unknown) => {
          await cleanupLocalTransferPath(target)
          throw error
        })
      }
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

export type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

export const DOWNLOAD_SESSION_TTL_MS = 30 * 60 * 1000
