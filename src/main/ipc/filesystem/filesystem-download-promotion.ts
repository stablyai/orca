import { randomUUID } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isENOENT } from '../filesystem-path-containment'

export function decodeDownloadedFileContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
}

export function createSiblingTransferPath(destinationPath: string, suffix: string): string {
  // Why: promotion renames must stay on the destination volume, so transfer paths remain siblings.
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

export type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

export const DOWNLOAD_SESSION_TTL_MS = 30 * 60 * 1000
