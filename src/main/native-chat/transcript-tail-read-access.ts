import type { TranscriptFileReader, TranscriptFileSource } from './transcript-file-source'
import { TAIL_CHUNK_BYTES } from './transcript-tail-boundary'
import { wslGatedRead, type TranscriptFileHandle } from './wsl-transcript-fs-access'

export function isTranscriptFileSource(
  value: TranscriptFileSource | AbortSignal | undefined
): value is TranscriptFileSource {
  return Boolean(value && 'supportsNativeWatch' in value)
}

export async function readLocalTranscriptChunk(
  handle: TranscriptFileHandle,
  filePath: string,
  offset: number,
  length: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await wslGatedRead(
    handle,
    filePath,
    buffer,
    0,
    length,
    offset,
    'exact',
    signal
  )
  return buffer.subarray(0, bytesRead)
}

export async function readSourceByteAt(
  reader: TranscriptFileReader,
  position: number,
  signal?: AbortSignal
): Promise<number | null> {
  const value = await reader.read(position, 1)
  signal?.throwIfAborted()
  return value.length === 1 ? value[0] : null
}

export async function findLastCompleteSourceLineEnd(
  reader: TranscriptFileReader,
  end: number,
  signal?: AbortSignal
): Promise<number> {
  const lastByte = await readSourceByteAt(reader, end - 1, signal)
  if (lastByte === null) {
    return 0
  }
  if (lastByte === 0x0a) {
    return end
  }
  let cursor = end
  while (cursor > 0) {
    signal?.throwIfAborted()
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const requestedBytes = cursor - start
    const buffer = await reader.read(start, requestedBytes)
    signal?.throwIfAborted()
    if (buffer.length < requestedBytes) {
      return 0
    }
    const newline = buffer.lastIndexOf(0x0a)
    if (newline !== -1) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}
