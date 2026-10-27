import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { RuntimeFileStatLike, TerminalFileGrant } from './file-grants'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES
} from '../../files/file-preview-budget'

export async function canonicalPathForArtifactComparison(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

export async function readFileHandleBufferBounded(
  handle: FileHandle,
  limit: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit)
  const { bytesRead } = await handle.read(buffer, 0, limit, 0)
  return buffer.subarray(0, bytesRead)
}

/** Pin all returnable bytes; size-rejected files need no digest. */
export async function localTerminalArtifactContentDigest(
  handle: FileHandle,
  size: number
): Promise<string | null> {
  if (size > LOCAL_PREVIEWABLE_BINARY_MAX_BYTES) {
    return null
  }
  // Why: hover probes mint grants for any path, so read only the file; procfs reports size 0 for real content.
  const buffer = await readFileHandleBufferBounded(
    handle,
    size === 0 ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES + 1 : size + 1
  )
  return terminalArtifactContentDigest(buffer)
}

export function terminalArtifactContentDigest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Callers size-check first, so this compares the entire granted file. */
export function assertTerminalArtifactContentUnchanged(
  grant: Pick<TerminalFileGrant, 'contentDigest'>,
  buffer: Buffer
): void {
  if (
    grant.contentDigest !== null &&
    grant.contentDigest !== terminalArtifactContentDigest(buffer)
  ) {
    throw new Error('terminal_file_grant_stale')
  }
}

// Remote peers recompute this identity; changes require capability negotiation.
export function terminalFileStatIdentity(stats: RuntimeFileStatLike): string | null {
  const dev = typeof stats.dev === 'number' ? stats.dev : null
  const ino = typeof stats.ino === 'number' ? stats.ino : null
  const nlink = typeof stats.nlink === 'number' ? stats.nlink : null
  const size = typeof stats.size === 'number' ? stats.size : null
  const mtimeMs =
    typeof stats.mtimeMs === 'number'
      ? stats.mtimeMs
      : typeof stats.mtime === 'number'
        ? stats.mtime
        : null
  if (dev !== null && ino !== null && size !== null && mtimeMs !== null) {
    return `${dev}:${ino}:${nlink ?? 'unknown'}:${size}:${mtimeMs}`
  }
  if (size !== null && mtimeMs !== null) {
    return `${size}:${mtimeMs}`
  }
  return null
}

export function assertTerminalFileGrantFresh(
  grant: TerminalFileGrant,
  stats: RuntimeFileStatLike
): void {
  const nextIdentity = terminalFileStatIdentity(stats)
  if (grant.statIdentity !== null && nextIdentity !== null && grant.statIdentity !== nextIdentity) {
    throw new Error('terminal_file_grant_stale')
  }
}

export function truncateMobileFilePreview(content: string): {
  content: string
  truncated: boolean
  byteLength: number
} {
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength <= MOBILE_FILE_READ_MAX_BYTES) {
    return { content, truncated: false, byteLength: buffer.byteLength }
  }
  return {
    content: buffer.subarray(0, MOBILE_FILE_READ_MAX_BYTES).toString('utf8'),
    truncated: true,
    byteLength: buffer.byteLength
  }
}
