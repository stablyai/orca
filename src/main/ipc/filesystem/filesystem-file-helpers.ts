import { randomUUID } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localLogFileIdentity } from '../../ai-vault/local-log-tail-reader'
import { isENOENT } from '../filesystem-path-containment'

// Why: Monaco degrades features on large files like VS Code, so a 5MB block would needlessly lock out ordinary JSON/log files.
export const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024 // 50MB
export const BINARY_PROBE_BYTES = 8192
export const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
// 32 visible matches plus one truncation sentinel stays below the legacy frame ceiling.
export const QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT = 33
// Why: previewable binaries are base64 blobs (not parsed as text), and local IPC has no frame limit (unlike the relay's 10MB), so 50MB is safe.
export const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024 // 50MB
export const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

export async function readLocalLogSnapshot(filePath: string): Promise<{
  content: string
  isBinary: boolean
  fileIdentity?: string
}> {
  const handle = await open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (stats.size > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit`
      )
    }
    const buffer = await handle.readFile()
    if (buffer.byteLength > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit`
      )
    }
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return {
      content: buffer.toString('utf8'),
      isBinary: false,
      fileIdentity: localLogFileIdentity(stats)
    }
  } finally {
    await handle.close()
  }
}

export function validateRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

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

/** Check if a buffer appears to be binary (contains null bytes in first 8KB). */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

export async function isBinaryFilePrefix(filePath: string): Promise<boolean> {
  const handle: FileHandle = await open(filePath, 'r')
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    return isBinaryBuffer(probe.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

export function isDirectoryEntry(entry: {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): boolean {
  // Why: following a symlink in readDir can touch macOS TCC-protected containers; treat links as file-like until explicitly opened.
  if (entry.isSymbolicLink()) {
    return false
  }
  return entry.isDirectory()
}

export type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

export const DOWNLOAD_SESSION_TTL_MS = 30 * 60 * 1000
