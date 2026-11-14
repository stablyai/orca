import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { noteTranscriptFsActivity } from './transcript-fs-observation'
import { parseSshTranscriptPath } from './ssh-transcript-path'
import type { WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import {
  openTranscriptFile,
  readTranscriptFile,
  closeTranscriptHandleWithSignal,
  WSL_TRANSCRIPT_READ_CHUNK_BYTES
} from './wsl-transcript-fs-access'

export type TranscriptReadStreamOptions = {
  start?: number
  end?: number
  /** Without encoding, decode Buffer chunks incrementally; boundaries may split multibyte codepoints. */
  encoding?: BufferEncoding
}

async function* gatedChunks(
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): AsyncGenerator<Buffer | string> {
  const handle = await openTranscriptFile(path, priority, signal)
  // Decode across chunk boundaries to avoid replacement characters on split codepoints.
  const decoder = options.encoding ? new StringDecoder(options.encoding) : null
  try {
    let position = options.start ?? 0
    for (;;) {
      const length =
        options.end === undefined
          ? WSL_TRANSCRIPT_READ_CHUNK_BYTES
          : Math.min(WSL_TRANSCRIPT_READ_CHUNK_BYTES, options.end - position + 1)
      if (length <= 0) {
        break
      }
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await readTranscriptFile(
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
    await closeTranscriptHandleWithSignal(handle, path, signal)
  }
}

/** Deadline each UNC chunk separately; gate refusal reaches consumers as a stream error. */
export function openTranscriptReadStream(
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
  return Readable.from(gatedChunks(path, options, priority, signal))
}
