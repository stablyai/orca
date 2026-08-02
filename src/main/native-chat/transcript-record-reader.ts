import { open } from 'node:fs/promises'
import type { AgentType } from '../../shared/native-chat-types'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  nativeChatLineDecoderForAgent
} from './transcript-tail-reader'

const RECORD_READ_CHUNK_BYTES = 64 * 1024
const UNAVAILABLE = 'Full message unavailable'

export type ReadNativeChatTextBlockArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  messageId: string
  recordOffset: number
  blockIndex: number
  /** Direct path for isolated tests. */
  filePath?: string
}

export async function readNativeChatTextBlock(
  args: ReadNativeChatTextBlockArgs
): Promise<{ text: string } | { error: string }> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { error: UNAVAILABLE }
  }
  const filePath = args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args))
  if (!filePath) {
    return { error: UNAVAILABLE }
  }
  try {
    const line = await readRecordAt(filePath, args.recordOffset)
    if (line === null) {
      return { error: UNAVAILABLE }
    }
    const message = decode(line, transcriptFallbackId(filePath, args.recordOffset))
    if (!message || message.id !== args.messageId) {
      return { error: UNAVAILABLE }
    }
    const block = message.blocks[args.blockIndex]
    return block?.type === 'text' ? { text: block.text } : { error: UNAVAILABLE }
  } catch {
    return { error: UNAVAILABLE }
  }
}

async function readRecordAt(filePath: string, offset: number): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    if (offset < 0 || offset >= size || !(await isRecordBoundary(handle, offset))) {
      return null
    }
    const chunks: Buffer[] = []
    let retainedBytes = 0
    let cursor = offset
    while (cursor < size) {
      const buffer = Buffer.allocUnsafe(Math.min(RECORD_READ_CHUNK_BYTES, size - cursor))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor)
      if (bytesRead === 0) {
        break
      }
      const content = buffer.subarray(0, bytesRead)
      const newline = content.indexOf(0x0a)
      const part = newline >= 0 ? content.subarray(0, newline) : content
      retainedBytes += part.length
      if (retainedBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
        return null
      }
      chunks.push(part)
      if (newline >= 0) {
        break
      }
      cursor += bytesRead
    }
    let line = Buffer.concat(chunks, retainedBytes).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    return line || null
  } finally {
    await handle.close()
  }
}

async function isRecordBoundary(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number
): Promise<boolean> {
  if (offset === 0) {
    return true
  }
  const previous = Buffer.allocUnsafe(1)
  const { bytesRead } = await handle.read(previous, 0, 1, offset - 1)
  return bytesRead === 1 && previous[0] === 0x0a
}
