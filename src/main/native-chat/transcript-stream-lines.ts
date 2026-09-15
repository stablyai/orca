import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export async function decodeTranscriptStream(
  stream: Readable,
  filePath: string,
  start: number,
  decode: TranscriptDecoder,
  includeTrailingLine: boolean
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const messages: NativeChatMessage[] = []
  let consumedBytes = 0

  const framer = createTranscriptLineFramer((line, byteLength, terminated) => {
    if (terminated || includeTrailingLine) {
      decodeLine(line, consumedBytes)
      consumedBytes += byteLength
    }
  })

  for await (const chunk of stream) {
    framer.write(chunk)
  }

  framer.end()

  return { messages, consumedBytes }

  function decodeLine(rawLine: string, relativeOffset: number): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (!line) {
      return
    }

    const message = decode(line, transcriptFallbackId(filePath, start + relativeOffset))

    if (message) {
      messages.push(message)
    }
  }
}

type TranscriptLine = { line: string; byteLength: number; terminated: boolean }

export async function* splitTranscriptStreamLines(
  stream: AsyncIterable<Buffer | string>,
  maxRecordBytes = Infinity
): AsyncGenerator<TranscriptLine> {
  let records: TranscriptLine[] = []

  const framer = createTranscriptLineFramer((line, byteLength, terminated) => {
    records.push({ line, byteLength, terminated })
  }, maxRecordBytes)

  for await (const chunk of stream) {
    framer.write(chunk)

    for (const record of records) {
      yield record
    }

    records = []
  }

  framer.end()

  for (const record of records) {
    yield record
  }
}

/** Frame chunks synchronously so native decoding avoids a promise per record. */
function createTranscriptLineFramer(
  emit: (line: string, byteLength: number, terminated: boolean) => void,
  maxRecordBytes = Infinity
): { write(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8')
  let pending: string[] = []
  let pendingBytes = 0

  return { write, end }

  function write(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let lineStart = 0
    let newlineIndex = text.indexOf('\n')

    while (newlineIndex !== -1) {
      let segment = text.slice(lineStart, newlineIndex + 1)
      checkRecordBytes(segment.slice(0, -1))

      if (pending.length > 0) {
        pending.push(segment)
        segment = pending.join('')
        pending = []
      }

      pendingBytes = 0
      emit(segment.slice(0, -1), Buffer.byteLength(segment, 'utf8'), true)
      lineStart = newlineIndex + 1
      newlineIndex = text.indexOf('\n', lineStart)
    }

    if (lineStart < text.length) {
      const segment = text.slice(lineStart)
      checkRecordBytes(segment)
      pending.push(segment)
    }
  }

  function checkRecordBytes(segment: string): void {
    if (maxRecordBytes === Infinity) {
      return
    }

    pendingBytes += Buffer.byteLength(segment, 'utf8')
    const previous = pending.at(-1)

    // Separately encoded surrogate halves become one four-byte codepoint when joined.
    if (previous && /[\uD800-\uDBFF]$/.test(previous) && /^[\uDC00-\uDFFF]/.test(segment)) {
      pendingBytes -= 2
    }

    if (pendingBytes > maxRecordBytes) {
      pending = []
      throw new Error(`Session transcript record exceeds ${maxRecordBytes} byte limit`)
    }
  }

  function end(): void {
    const tail = decoder.end()

    if (tail) {
      checkRecordBytes(tail)
      pending.push(tail)
    }

    const line = pending.join('')
    emit(line, Buffer.byteLength(line, 'utf8'), false)
    pending = []
  }
}
