import { Readable } from 'node:stream'
import { decompressDshFrames } from './session-scanner-dsh-zstd'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'

export async function* dshTranscriptLines(
  path: string,
  bytes: AsyncIterable<Buffer>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  signal?.throwIfAborted()
  const stream = Readable.from(path.endsWith('.zstd') ? decompressDshFrames(bytes) : bytes)
  const cancel = () => stream.destroy(new Error('DSH transcript read cancelled'))
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for await (const record of splitTranscriptStreamLines(
      stream,
      MAX_SESSION_TRANSCRIPT_RECORD_BYTES
    )) {
      signal?.throwIfAborted()
      if (record.terminated) {
        yield record.line
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    stream.destroy()
  }
}

export function localDshTranscriptBytes(path: string): AsyncIterable<Buffer> {
  return openTranscriptReadStream(path, {}, 'scan')
}
