import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { localLogFileIdentity } from '../../ai-vault/local-log-tail-reader'

// Why: Monaco degrades features on large files like VS Code, so a 5MB block would needlessly lock out ordinary JSON/log files.
export const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024 // 50MB
export const BINARY_PROBE_BYTES = 8192
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
