import type { FileHandle } from 'node:fs/promises'
import type { RuntimeFileReadChunkResult } from '../../shared/file-content/runtime-file-read'
import {
  FOLDER_ARCHIVE_MAX_READ_BYTES,
  type FileArchiveReadResult,
  type FileArchiveStartResult
} from '../../shared/rpc-contract/files-archive-params'
import type { RuntimeDownloadErrorCode } from '../../shared/runtime-downloads/runtime-download-contract'

/** files.readChunk's schema ceiling; older hosts accept nothing larger. */
const FILE_CHUNK_BYTES = 512 * 1024
// The main-process bulk-read lane admits two calls per host, so a third would only queue.
const FILE_CHUNK_CONCURRENCY = 2
const CHUNK_TIMEOUT_MS = 60_000
// The walk of a large tree runs before the first byte; give it room.
const ARCHIVE_START_TIMEOUT_MS = 120_000

export class RuntimeDownloadError extends Error {
  constructor(
    readonly code: RuntimeDownloadErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = 'RuntimeDownloadError'
  }
}

export type RuntimeDownloadCall = <T>(
  method: string,
  params: unknown,
  options: { timeoutMs: number; signal: AbortSignal }
) => Promise<T>

export type RuntimeDownloadProgress = {
  receivedBytes: number
  /** Expected bytes; for folders this counts uncompressed source bytes, not ZIP bytes. */
  totalBytes: number | null
  /** Source bytes covered so far, comparable with totalBytes. */
  processedBytes: number
}

type TransferInput = {
  call: RuntimeDownloadCall
  worktree: string
  relativePath: string
  sink: FileHandle
  signal: AbortSignal
  onProgress: (progress: RuntimeDownloadProgress) => void
}

/** Pages a remote file into `sink` with a few positional reads in flight to hide link latency. */
export async function transferRuntimeFile(
  input: TransferInput & { maxBytes?: number; chunkBytes?: number; concurrency?: number }
): Promise<{ bytes: number }> {
  const chunkBytes = input.chunkBytes ?? FILE_CHUNK_BYTES
  const stat = await input.call<{ size: number; isDirectory: boolean }>(
    'files.stat',
    { worktree: input.worktree, relativePath: input.relativePath },
    { timeoutMs: CHUNK_TIMEOUT_MS, signal: input.signal }
  )
  if (stat.isDirectory) {
    throw new RuntimeDownloadError('not_a_file')
  }
  if (input.maxBytes !== undefined && stat.size > input.maxBytes) {
    throw new RuntimeDownloadError('too_large')
  }
  let nextOffset = 0
  // The file may change size mid-transfer; the first EOF page fixes the final length.
  let endOffset: number | null = null
  let received = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (input.signal.aborted) {
        throw new RuntimeDownloadError('canceled')
      }
      if (endOffset !== null && nextOffset >= endOffset) {
        return
      }
      const offset = nextOffset
      nextOffset += chunkBytes
      const chunk = await input.call<RuntimeFileReadChunkResult>(
        'files.readChunk',
        {
          worktree: input.worktree,
          relativePath: input.relativePath,
          offset,
          length: chunkBytes
        },
        { timeoutMs: CHUNK_TIMEOUT_MS, signal: input.signal }
      )
      if (chunk.bytesRead > 0) {
        const bytes = Buffer.from(chunk.contentBase64, 'base64')
        if (bytes.byteLength !== chunk.bytesRead) {
          throw new RuntimeDownloadError('transfer_failed', 'Remote page length mismatch')
        }
        await input.sink.write(bytes, 0, bytes.byteLength, offset)
        received += bytes.byteLength
        input.onProgress({
          receivedBytes: received,
          totalBytes: stat.size,
          processedBytes: received
        })
      }
      if (chunk.eof || chunk.bytesRead < chunkBytes) {
        const end = offset + chunk.bytesRead
        endOffset = endOffset === null ? end : Math.min(endOffset, end)
        return
      }
    }
  }
  const concurrency = Math.max(1, input.concurrency ?? FILE_CHUNK_CONCURRENCY)
  await Promise.all(Array.from({ length: concurrency }, worker))
  const finalLength = endOffset ?? received
  // A page past a shrunken EOF may have landed; cut the file back to the agreed length.
  await input.sink.truncate(finalLength)
  return { bytes: finalLength }
}

export type FolderTransferResult = {
  bytes: number
  skippedCount: number
  excludedDirCount: number
  fileCount: number
}

/** Asks the host to zip a folder, then appends its pages to `sink` until EOF. */
export async function transferRuntimeFolder(
  input: TransferInput & { excludeDefaultDirs: boolean }
): Promise<FolderTransferResult> {
  const started = await input.call<FileArchiveStartResult>(
    'files.archiveStart',
    {
      worktree: input.worktree,
      relativePath: input.relativePath,
      excludeDefaultDirs: input.excludeDefaultDirs
    },
    { timeoutMs: ARCHIVE_START_TIMEOUT_MS, signal: input.signal }
  )
  let finished = false
  let received = 0
  try {
    for (;;) {
      if (input.signal.aborted) {
        throw new RuntimeDownloadError('canceled')
      }
      const page = await input.call<FileArchiveReadResult>(
        'files.archiveRead',
        { archiveId: started.archiveId, maxBytes: FOLDER_ARCHIVE_MAX_READ_BYTES },
        { timeoutMs: CHUNK_TIMEOUT_MS, signal: input.signal }
      )
      if (page.bytesRead > 0) {
        const bytes = Buffer.from(page.contentBase64, 'base64')
        await input.sink.write(bytes, 0, bytes.byteLength, received)
        received += bytes.byteLength
      }
      input.onProgress({
        receivedBytes: received,
        totalBytes: started.totalBytes,
        processedBytes: page.processedBytes
      })
      if (page.eof) {
        finished = true
        return {
          bytes: received,
          skippedCount: page.skippedCount,
          excludedDirCount: started.excludedDirCount,
          fileCount: started.fileCount
        }
      }
    }
  } finally {
    if (!finished) {
      // Best effort: the host's idle timer frees the session if this never arrives.
      const release = new AbortController()
      void input
        .call(
          'files.archiveCancel',
          { archiveId: started.archiveId },
          {
            timeoutMs: 10_000,
            signal: release.signal
          }
        )
        .catch(() => {})
    }
  }
}
