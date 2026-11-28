import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import { inTranscriptFileOrder } from './transcript-file-order'

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export async function decodeTranscriptStream(
  stream: Readable,
  filePath: string,
  start: number,
  decode: TranscriptDecoder,
  includeTrailingLine: boolean,
  maxRecordBytes = Infinity,
  sourceOrder = false
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const messages: NativeChatMessage[] = []
  let consumedBytes = 0
  let latest = Number.NEGATIVE_INFINITY
  const framer = createTranscriptLineFramer((line, byteLength, terminated) => {
    if (terminated || includeTrailingLine) {
      decodeLine(line, consumedBytes)
      consumedBytes += byteLength
    }
  }, maxRecordBytes)
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
      const ordered = inTranscriptFileOrder(
        message,
        latest,
        sourceOrder ? start + relativeOffset : undefined
      )
      latest = ordered.latest
      messages.push(ordered.message)
    }
  }
}

type TranscriptLine = { line: string; byteLength: number; terminated: boolean }

/** `oversizedLine` may return a stand-in for an over-limit record, which is then counted, not buffered. */
export async function* splitTranscriptStreamLines(
  stream: AsyncIterable<Buffer | string>,
  maxRecordBytes = Infinity,
  oversizedLine?: (head: string) => string | undefined
): AsyncGenerator<TranscriptLine> {
  let records: TranscriptLine[] = []
  const framer = createTranscriptLineFramer(
    (line, byteLength, terminated) => {
      records.push({ line, byteLength, terminated })
    },
    maxRecordBytes,
    oversizedLine
  )
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
  maxRecordBytes = Infinity,
  oversizedLine?: (head: string) => string | undefined
): { write(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8')
  let pending: string[] = []
  let pendingBytes = 0
  let standIn: string | undefined
  return { write, end }

  function write(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let lineStart = 0
    let newlineIndex = text.indexOf('\n')
    while (newlineIndex !== -1) {
      let segment = text.slice(lineStart, newlineIndex + 1)
      checkRecordBytes(segment.slice(0, -1))
      if (standIn !== undefined) {
        emit(standIn, pendingBytes + 1, true)
        standIn = undefined
        pending = []
      } else {
        if (pending.length > 0) {
          pending.push(segment)
          segment = pending.join('')
          pending = []
        }
        emit(segment.slice(0, -1), Buffer.byteLength(segment, 'utf8'), true)
      }
      pendingBytes = 0
      lineStart = newlineIndex + 1
      newlineIndex = text.indexOf('\n', lineStart)
    }
    if (lineStart < text.length) {
      const segment = text.slice(lineStart)
      checkRecordBytes(segment)
      if (standIn !== undefined) {
        // Keep only the last fragment, which the surrogate check needs.
        pending = []
      }
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
    if (pendingBytes > maxRecordBytes && standIn === undefined) {
      standIn = oversizedLine?.(recordHead([...pending, segment]))
      pending = []
      if (standIn === undefined) {
        throw new Error(`Session transcript record exceeds ${maxRecordBytes} byte limit`)
      }
    }
  }

  function end(): void {
    const tail = decoder.end()
    if (tail) {
      checkRecordBytes(tail)
      pending.push(tail)
    }
    if (standIn !== undefined) {
      emit(standIn, pendingBytes, false)
      standIn = undefined
      pending = []
      return
    }
    const line = pending.join('')
    emit(line, Buffer.byteLength(line, 'utf8'), false)
    pending = []
  }
}

function recordHead(fragments: string[]): string {
  let head = ''
  for (const fragment of fragments) {
    if (head.length >= 1024) {
      break
    }
    head += fragment.slice(0, 1024)
  }
  return head
}
