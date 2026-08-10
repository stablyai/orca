import { open } from 'node:fs/promises'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  createCodexTranscriptLineDecoder,
  decodeClaudeTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine,
  isCodexPaginatedHistoryMarker
} from './transcript-line-decoders'

const FIRST_RECORD_CHUNK_BYTES = 64 * 1024
const MAX_FIRST_RECORD_BYTES = 2 * 1024 * 1024

export type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export function nativeChatLineDecoderForAgent(
  agent: AgentType,
  options: { codexPaginated?: boolean } = {}
): NativeChatLineDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'claude') {
    return decodeClaudeTranscriptLine
  }
  if (transcriptAgent === 'codex') {
    return createCodexTranscriptLineDecoder({ paginated: options.codexPaginated })
  }
  if (transcriptAgent === 'grok') {
    return decodeGrokTranscriptLine
  }
  if (transcriptAgent === 'omp') {
    return decodeOmpTranscriptLine
  }
  return null
}

export async function nativeChatLineDecoderForTranscript(
  agent: AgentType,
  filePath: string
): Promise<NativeChatLineDecoder | null> {
  return nativeChatLineDecoderForAgent(agent, {
    codexPaginated:
      resolveNativeChatTranscriptAgent(agent) === 'codex' &&
      (await codexTranscriptStartsPaginated(filePath))
  })
}

async function codexTranscriptStartsPaginated(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  const parts: Buffer[] = []
  let offset = 0
  try {
    while (offset <= MAX_FIRST_RECORD_BYTES) {
      const remaining = MAX_FIRST_RECORD_BYTES + 1 - offset
      const buffer = Buffer.allocUnsafe(Math.min(FIRST_RECORD_CHUNK_BYTES, remaining))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) {
        break
      }
      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        parts.push(chunk.subarray(0, newline))
        break
      }
      parts.push(chunk)
      offset += bytesRead
    }
    const firstRecord = Buffer.concat(parts)
    if (firstRecord.byteLength > MAX_FIRST_RECORD_BYTES) {
      return false
    }
    return isCodexPaginatedHistoryMarker(firstRecord.toString('utf8').replace(/\r$/, ''))
  } finally {
    await handle.close()
  }
}
