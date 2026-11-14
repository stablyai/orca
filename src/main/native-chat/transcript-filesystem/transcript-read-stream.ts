import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { noteTranscriptFsActivity } from './transcript-fs-observation'
import { parseSshTranscriptPath } from './ssh-transcript-path'
import type { WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import type {
  openTranscriptFile,
  readTranscriptFile,
  closeTranscriptHandleWithSignal
} from './wsl-transcript-fs-access'

type TranscriptStreamAccess = {
  open: typeof openTranscriptFile
  read: typeof readTranscriptFile
  close: typeof closeTranscriptHandleWithSignal
  chunkBytes: number
}

export type TranscriptReadStreamOptions = {
  start?: number
  end?: number
  /** Without encoding, decode Buffer chunks incrementally; boundaries may split multibyte codepoints. */
  encoding?: BufferEncoding
}

async function* gatedChunks(
  access: TranscriptStreamAccess,
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): AsyncGenerator<Buffer | string> {
  const handle = await access.open(path, priority, signal)
  // Decode across chunk boundaries to avoid replacement characters on split codepoints.
  const decoder = options.encoding ? new StringDecoder(options.encoding) : null
  try {
    let position = options.start ?? 0
    for (;;) {
      const length =
        options.end === undefined
          ? access.chunkBytes
          : Math.min(access.chunkBytes, options.end - position + 1)
      if (length <= 0) {
        break
      }
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await access.read(
        handle,
        path,
        buffer,
        0,
        length,
        position,
        priority,
        signal
      )
      if (bytesRead <= 0) {
        break
      }
      position += bytesRead
      const chunk = buffer.subarray(0, bytesRead)
      if (!decoder) {
        yield chunk
        continue
      }
      const decoded = decoder.write(chunk)
      if (decoded) {
        yield decoded
      }
    }
    const trailing = decoder?.end()
    if (trailing) {
      yield trailing
    }
  } finally {
    // Readable.destroy calls generator return, closing handles even after aborted head reads.
    await access.close(handle, path, signal)
  }
}

/** Bind the existing handle operations without a runtime dependency back to the public facade. */
export function createTranscriptReadStream(access: TranscriptStreamAccess) {
  return function openTranscriptReadStream(
    path: string,
    options: TranscriptReadStreamOptions,
    priority: WslTranscriptFsTaskPriority,
    signal?: AbortSignal
  ): Readable {
    if (!isWslUncPath(path) && !parseSshTranscriptPath(path)) {
      const stream = createReadStream(path, { ...options, signal })
      stream.on('data', noteTranscriptFsActivity)
      stream.pause()
      return stream
    }
    return Readable.from(gatedChunks(access, path, options, priority, signal))
  }
}
