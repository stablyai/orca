import type { FileHandle } from 'node:fs/promises'
import type { RuntimeFileReadChunkResult } from '../../shared/file-content/runtime-file-read'
import {
  FOLDER_ARCHIVE_MAX_ENTRIES,
  FOLDER_ARCHIVE_MAX_READ_BYTES,
  FOLDER_ARCHIVE_MAX_TOTAL_BYTES,
  type FileArchiveReadResult,
  type FileArchiveStartResult
} from '../../shared/rpc-contract/files-archive-params'
import type { RuntimeDownloadErrorCode } from '../../shared/runtime-downloads/runtime-download-contract'

/** files.readChunk's schema ceiling; older hosts accept nothing larger. */
const FILE_CHUNK_BYTES = 512 * 1024
// Matches the main-process download lane: four pages in flight hide ~65 ms of RTT.
const FILE_CHUNK_CONCURRENCY = 4
const CHUNK_TIMEOUT_MS = 60_000
// The walk of a large tree runs before the first byte; give it room.
const ARCHIVE_START_TIMEOUT_MS = 120_000
// The host is not trusted to stop. A file may grow a little while it is copied; past this much over
// its announced size the download stops instead of filling this computer's disk.
const FILE_GROWTH_ALLOWANCE_BYTES = 64 * 1024 * 1024
// A ZIP of at most 2 GiB of files: deflate never grows data by more than ~0.1 %, plus local and
// central headers (well under 1 KiB each for 65,000 entries).
const FOLDER_ARCHIVE_MAX_ZIP_BYTES =
  FOLDER_ARCHIVE_MAX_TOTAL_BYTES * 1.01 + FOLDER_ARCHIVE_MAX_ENTRIES * 1024

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
  /** Folder downloads only. */
  fileCount?: number
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
  // The first pages go out with stat instead of after it: one round trip less per download, most
  // of a small file's time on a ~65 ms link. A capped download still learns the size first.
  const statReady = input
    .call<{ size: number; isDirectory: boolean }>(
      'files.stat',
      { worktree: input.worktree, relativePath: input.relativePath },
      { timeoutMs: CHUNK_TIMEOUT_MS, signal: input.signal }
    )
    .then((stat) => {
      if (stat.isDirectory) {
        throw new RuntimeDownloadError('not_a_file')
      }
      if (input.maxBytes !== undefined && stat.size > input.maxBytes) {
        throw new RuntimeDownloadError('too_large')
      }
      // Hard stop for a host that keeps answering full pages past the size it announced.
      return {
        size: stat.size,
        byteLimit: Math.min(
          input.maxBytes ?? Number.POSITIVE_INFINITY,
          stat.size + FILE_GROWTH_ALLOWANCE_BYTES
        )
      }
    })
  // Workers await it; this only keeps an early stat failure from going unhandled meanwhile.
  statReady.catch(() => {})
  if (input.maxBytes !== undefined) {
    await statReady
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
      const chunk = await input
        .call<RuntimeFileReadChunkResult>(
          'files.readChunk',
          {
            worktree: input.worktree,
            relativePath: input.relativePath,
            offset,
            length: chunkBytes
          },
          { timeoutMs: CHUNK_TIMEOUT_MS, signal: input.signal }
        )
        .catch(async (error: unknown) => {
          // A page raced ahead of stat: stat's verdict (not a file, too large) explains it better.
          await statReady
          throw error
        })
      const { size, byteLimit } = await statReady
      if (offset + chunk.bytesRead > byteLimit) {
        throw new RuntimeDownloadError('too_large')
      }
      if (chunk.bytesRead > 0) {
        const bytes = Buffer.from(chunk.contentBase64, 'base64')
        if (bytes.byteLength !== chunk.bytesRead) {
          throw new RuntimeDownloadError('transfer_failed', 'Remote page length mismatch')
        }
        await input.sink.write(bytes, 0, bytes.byteLength, offset)
        received += bytes.byteLength
        input.onProgress({
          receivedBytes: received,
          totalBytes: size,
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
  // An empty file can finish its pages before stat answers; stat must still pass.
  await statReady
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
  // Not tied to the user's cancel: the host only learns of a cancel through archiveCancel, so a
  // start canceled mid-walk must still deliver its id for release (else it holds a slot until idle).
  const startRequest = input.call<FileArchiveStartResult>(
    'files.archiveStart',
    {
      worktree: input.worktree,
      relativePath: input.relativePath,
      excludeDefaultDirs: input.excludeDefaultDirs
    },
    { timeoutMs: ARCHIVE_START_TIMEOUT_MS, signal: new AbortController().signal }
  )
  const started = await raceAbort(startRequest, input.signal, (late) =>
    releaseArchive(input.call, late.archiveId)
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
        if (received + bytes.byteLength > FOLDER_ARCHIVE_MAX_ZIP_BYTES) {
          throw new RuntimeDownloadError('too_large')
        }
        await input.sink.write(bytes, 0, bytes.byteLength, received)
        received += bytes.byteLength
      }
      input.onProgress({
        receivedBytes: received,
        totalBytes: started.totalBytes,
        processedBytes: page.processedBytes,
        fileCount: started.fileCount
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
      releaseArchive(input.call, started.archiveId)
    }
  }
}

/** Best effort: the host's idle timer frees the session if this never arrives. */
function releaseArchive(call: RuntimeDownloadCall, archiveId: string): void {
  void call(
    'files.archiveCancel',
    { archiveId },
    { timeoutMs: 10_000, signal: new AbortController().signal }
  ).catch(() => {})
}

/** Rejects with `canceled` as soon as `signal` aborts; a result that lands later goes to `onLate`. */
function raceAbort<T>(
  request: Promise<T>,
  signal: AbortSignal,
  onLate: (value: T) => void
): Promise<T> {
  if (signal.aborted) {
    void request.then(onLate, () => {})
    return Promise.reject(new RuntimeDownloadError('canceled'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void request.then(onLate, () => {})
      reject(new RuntimeDownloadError('canceled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    request.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          return
        }
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
