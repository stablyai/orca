/**
 * The moved worktrees' zsh/bash history files (under the desktop's per-distro WSL history root) as
 * `shell-history` migration blobs, keyed by the worktree id the destination host will use.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertOrcadMigrationBlobSet,
  orcadMigrationBlobIdentity,
  sameOrcadMigrationBlob,
  type OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationBlobSource } from '../../ssh/orcad-migration-blob-coordinator'
import { getHistoryRootWsl } from '../../terminal-history-paths'
import { hashWorktreeId } from '../../terminal-history-id'
import {
  MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES,
  ORCAD_MIGRATION_SHELL_HISTORY_SHELLS,
  encodeOrcadMigrationShellHistoryHeader,
  orcadMigrationShellHistoryKey,
  shellHistoryFileName
} from '../migrating-orcad-catalog/orcad-migration-shell-history-format'

export type WslMoveShellHistoryWorktree = {
  /** The id the desktop keyed history by: the UNC worktree id. */
  sourceWorktreeId: string
  /** The same worktree's id on the host, after the mover's path rewrite. */
  destinationWorktreeId: string
}

export type WslMoveShellHistoryRequest = {
  distro: string
  worktrees: readonly WslMoveShellHistoryWorktree[]
  /** Defaults to the desktop's history root for `distro`. */
  historyRoot?: string
}

export type WslMoveShellHistoryBlobs = {
  descriptors: OrcadMigrationBlobDescriptor[]
  source: OrcadMigrationBlobSource
}

type DesktopHistoryFile = { path: string; fileBytes: number }

/** A blob's bytes in order: the header, then one or more desktop history files. */
type ShellHistorySegment = { bytes: Buffer } | DesktopHistoryFile

type ShellHistoryBlob = {
  descriptor: OrcadMigrationBlobDescriptor
  segments: ShellHistorySegment[]
}

const NEWLINE = 0x0a

/**
 * Missing and empty files send nothing. A file over the per-blob cap blocks the move: history is
 * never truncated. The source refuses a read once a file's size moved, so a shell that wrote after
 * quiesce fails the transfer instead of sending bytes the digest does not cover.
 */
export async function buildWslMoveShellHistoryBlobs(
  request: WslMoveShellHistoryRequest
): Promise<WslMoveShellHistoryBlobs> {
  const root = request.historyRoot ?? getHistoryRootWsl(request.distro)
  const blobs: ShellHistoryBlob[] = []
  for (const [destinationWorktreeId, sourceWorktreeIds] of groupByDestination(request.worktrees)) {
    let zshSent = false
    for (const shell of ORCAD_MIGRATION_SHELL_HISTORY_SHELLS) {
      const files = await desktopHistoryFiles(root, sourceWorktreeIds, shellHistoryFileName(shell))
      if (files.length === 0) {
        continue
      }
      const key = orcadMigrationShellHistoryKey(destinationWorktreeId, shell)
      // zsh is listed first, so a bash file without a zsh sibling is known here.
      const header = encodeOrcadMigrationShellHistoryHeader(destinationWorktreeId, {
        loginShell: shell === 'bash' && !zshSent
      })
      zshSent ||= shell === 'zsh'
      const segments = await joinHistories(header, files)
      const byteLength = segments.reduce((total, segment) => total + segmentBytes(segment), 0)
      // A move blocker rather than a truncation: dropping old commands would silently lose them.
      if (byteLength > MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES) {
        throw new Error(
          `orcad_migration_shell_history_too_large:${key}: the ${shell} history of ${destinationWorktreeId} is ${byteLength} bytes, over the ${MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES}-byte limit`
        )
      }
      blobs.push({
        descriptor: {
          blobKind: 'shell-history',
          key,
          sha256: await digestSegments(segments),
          byteLength
        },
        segments
      })
    }
  }
  const descriptors = blobs.map((blob) => blob.descriptor)
  assertOrcadMigrationBlobSet(descriptors)
  const byIdentity = new Map(
    blobs.map((blob) => [orcadMigrationBlobIdentity(blob.descriptor), blob])
  )
  return {
    descriptors,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        const blob = byIdentity.get(orcadMigrationBlobIdentity(requested))
        if (!blob || !sameOrcadMigrationBlob(requested, blob.descriptor)) {
          throw new Error(`orcad_migration_source_blob_changed:${requested.blobKind}`)
        }
        return readSegments(blob, offset, maxBytes)
      }
    }
  }
}

// The `\\wsl$\` and `\\wsl.localhost\` ids of one worktree rewrite to the same host id.
function groupByDestination(
  worktrees: readonly WslMoveShellHistoryWorktree[]
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const worktree of worktrees) {
    const sources = groups.get(worktree.destinationWorktreeId) ?? []
    if (!sources.includes(worktree.sourceWorktreeId)) {
      sources.push(worktree.sourceWorktreeId)
    }
    groups.set(worktree.destinationWorktreeId, sources)
  }
  return groups
}

// Oldest first, so the newest commands end up last, where shells read them back from.
async function desktopHistoryFiles(
  root: string,
  sourceWorktreeIds: readonly string[],
  fileName: string
): Promise<DesktopHistoryFile[]> {
  const found: (DesktopHistoryFile & { mtimeMs: number })[] = []
  for (const sourceWorktreeId of sourceWorktreeIds) {
    const path = join(root, hashWorktreeId(sourceWorktreeId), fileName)
    const info = await regularFile(path)
    if (info && info.size > 0) {
      found.push({ path, fileBytes: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return found
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(({ path, fileBytes }) => ({ path, fileBytes }))
}

// Without a newline between them, one file's last command would run into the next file's first.
async function joinHistories(
  header: Buffer,
  files: readonly DesktopHistoryFile[]
): Promise<ShellHistorySegment[]> {
  const segments: ShellHistorySegment[] = [{ bytes: header }]
  for (const [index, file] of files.entries()) {
    segments.push(file)
    if (index < files.length - 1 && (await lastByte(file)) !== NEWLINE) {
      segments.push({ bytes: Buffer.from('\n') })
    }
  }
  return segments
}

async function lastByte(file: DesktopHistoryFile): Promise<number | undefined> {
  const [byte] = await readFileRange(file, file.fileBytes - 1, file.fileBytes)
  return byte
}

function segmentBytes(segment: ShellHistorySegment): number {
  return 'bytes' in segment ? segment.bytes.length : segment.fileBytes
}

// Null for a missing file or anything that is not a regular file.
async function regularFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null
  } catch {
    return null
  }
}

async function digestSegments(segments: readonly ShellHistorySegment[]): Promise<string> {
  const hash = createHash('sha256')
  for (const segment of segments) {
    if ('bytes' in segment) {
      hash.update(segment.bytes)
      continue
    }
    let read = 0
    // `end` pins the digest to the size the descriptor declares even if the file grows meanwhile.
    for await (const chunk of createReadStream(segment.path, {
      start: 0,
      end: segment.fileBytes - 1
    })) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('orcad_migration_shell_history_read_failed')
      }
      hash.update(chunk)
      read += chunk.length
    }
    if (read !== segment.fileBytes) {
      throw new Error('orcad_migration_source_blob_changed:shell-history')
    }
  }
  return hash.digest('hex')
}

async function readSegments(
  blob: ShellHistoryBlob,
  offset: number,
  maxBytes: number
): Promise<Buffer> {
  const end = Math.min(offset + maxBytes, blob.descriptor.byteLength)
  const parts: Buffer[] = []
  let segmentStart = 0
  for (const segment of blob.segments) {
    const size = segmentBytes(segment)
    const from = Math.max(offset - segmentStart, 0)
    const to = Math.min(end - segmentStart, size)
    if (to > from) {
      parts.push(
        'bytes' in segment
          ? segment.bytes.subarray(from, to)
          : await readFileRange(segment, from, to)
      )
    }
    segmentStart += size
  }
  return Buffer.concat(parts)
}

async function readFileRange(file: DesktopHistoryFile, from: number, to: number): Promise<Buffer> {
  const handle = await open(file.path, 'r')
  try {
    if ((await handle.stat()).size !== file.fileBytes) {
      throw new Error('orcad_migration_source_blob_changed:shell-history')
    }
    const buffer = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    if (bytesRead !== buffer.length) {
      throw new Error('orcad_migration_source_blob_changed:shell-history')
    }
    return buffer
  } finally {
    await handle.close()
  }
}
