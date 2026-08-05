import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CURSOR_SIDECAR_MAX_BYTES,
  cursorSessionStorePath,
  isCursorSidecarDirectory,
  isCursorSidecarPath
} from './session-scanner-cursor-paths'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function discoverLocalCursorSidecars(
  chatsDir: string,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime[]> {
  let buckets
  try {
    buckets = await readdir(chatsDir, { withFileTypes: true })
  } catch (error) {
    if (!isMissingCursorPathError(error)) {
      issues.push({ agent: 'cursor', path: chatsDir, message: errorMessage(error) })
    }
    return []
  }
  const files: FileWithMtime[] = []
  for (const bucket of buckets) {
    if (
      !bucket.isDirectory() ||
      bucket.isSymbolicLink() ||
      !isCursorSidecarDirectory(bucket.name, 0)
    ) {
      continue
    }
    const bucketDir = join(chatsDir, bucket.name)
    let sessions
    try {
      sessions = await readdir(bucketDir, { withFileTypes: true })
    } catch (error) {
      if (!isMissingCursorPathError(error)) {
        issues.push({ agent: 'cursor', path: bucketDir, message: errorMessage(error) })
      }
      continue
    }
    for (const session of sessions) {
      if (
        session.isDirectory() &&
        !session.isSymbolicLink() &&
        isCursorSidecarDirectory(session.name, 1)
      ) {
        const metaPath = join(bucketDir, session.name, 'meta.json')
        if (isCursorSidecarPath(chatsDir, metaPath)) {
          const file = await cursorLocalFileMetadata(metaPath)
          if (file) {
            files.push(file)
          }
        }
      }
    }
  }
  return files
}

export async function validateLocalCursorSidecars(
  files: readonly FileWithMtime[],
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime[]> {
  const retained: FileWithMtime[] = []
  for (const file of files) {
    try {
      const [metaStat, storeStat] = await Promise.all([
        lstat(file.path),
        lstat(cursorSessionStorePath(file.path))
      ])
      if (
        !metaStat.isFile() ||
        metaStat.isSymbolicLink() ||
        !storeStat.isFile() ||
        storeStat.isSymbolicLink()
      ) {
        continue
      }
      if (metaStat.size > CURSOR_SIDECAR_MAX_BYTES) {
        issues.push({
          agent: 'cursor',
          path: file.path,
          message: 'Cursor session metadata exceeds the read limit.'
        })
        continue
      }
      retained.push({
        ...file,
        sizeBytes: metaStat.size,
        cursorStoreMtimeMs: storeStat.mtimeMs
      })
    } catch (error) {
      if (!isMissingCursorPathError(error)) {
        issues.push({ agent: 'cursor', path: file.path, message: errorMessage(error) })
      }
    }
  }
  return retained
}

export async function localCursorRootRealPath(
  chatsDir: string,
  issues: AiVaultScanIssue[]
): Promise<string | null> {
  try {
    return await realpath(chatsDir)
  } catch (error) {
    if (!isMissingCursorPathError(error)) {
      issues.push({ agent: 'cursor', path: chatsDir, message: errorMessage(error) })
    }
    return null
  }
}

export async function cursorLocalFileMetadata(filePath: string): Promise<FileWithMtime | null> {
  try {
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return null
    }
    return {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
      dev: fileStat.dev,
      ino: fileStat.ino,
      nlink: fileStat.nlink
    }
  } catch {
    return null
  }
}

export function isMissingCursorPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}
