import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { decodeClaudeTranscriptLine, decodeCodexTranscriptLine } from './transcript-line-decoders'

export type ReadTranscriptResult = { messages: NativeChatMessage[] } | { error: string }

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
  /** Read only the newest messages when callers use windowed pagination. */
  maxMessages?: number
}

/**
 * Read a Claude/Codex JSONL transcript into the NativeChatMessage model.
 * Windowed callers read a bounded tail; callers that omit maxMessages retain
 * the full-transcript behavior used by focused reader tests and diagnostics.
 * Unknown record types are skipped rather than throwing, so a malformed or
 * unrecognized line cannot fail the whole read.
 */
export async function readNativeChatTranscript(
  agent: AgentType,
  sessionId: string,
  options: ReadTranscriptOptions = {}
): Promise<ReadTranscriptResult> {
  const filePath = options.filePath ?? (await resolveSessionFilePath(agent, sessionId, options))
  if (!filePath) {
    return { error: `No transcript found for ${agent} session ${sessionId}` }
  }
  try {
    if (agent === 'claude') {
      return {
        messages: await readTranscript(filePath, decodeClaudeTranscriptLine, options.maxMessages)
      }
    }
    if (agent === 'codex') {
      return {
        messages: await readTranscript(filePath, decodeCodexTranscriptLine, options.maxMessages)
      }
    }
    return { error: `Unsupported agent for native chat transcript: ${agent}` }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

async function readTranscript(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  maxMessages?: number
): Promise<NativeChatMessage[]> {
  const requestedMax =
    maxMessages && Number.isFinite(maxMessages) && maxMessages > 0 ? Math.floor(maxMessages) : null
  let startOffset = 0
  if (requestedMax !== null) {
    try {
      const size = (await stat(filePath)).size
      // Keep a generous tail so a large tool record still has room to decode,
      // while avoiding a full scan of years of transcript history.
      startOffset = Math.max(0, size - 32 * 1024 * 1024)
    } catch {
      startOffset = 0
    }
  }
  const reader = createInterface({
    input: createReadStream(filePath, {
      encoding: 'utf-8',
      ...(startOffset > 0 ? { start: startOffset } : {})
    }),
    crlfDelay: Infinity
  })
  const messages: NativeChatMessage[] = []
  let index = 0
  let skippedPartialLine = startOffset === 0
  for await (const line of reader) {
    if (!skippedPartialLine) {
      skippedPartialLine = true
      continue
    }
    // Why: fallback id embeds start offset 0 so it matches the live tailer's id
    // for the same record (the tailer's first drain reads from offset 0 too).
    // Records that re-emit then collapse by id in the assembler — no dup, no drop.
    const message = decode(line, `${filePath}:0:${index}`)
    if (message) {
      messages.push(message)
      if (requestedMax !== null && messages.length > requestedMax) {
        messages.shift()
      }
    }
    index++
  }
  return messages
}
