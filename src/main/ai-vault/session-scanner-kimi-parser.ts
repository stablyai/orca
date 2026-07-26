import type { AiVaultSession } from '../../shared/ai-vault-types'
import { iterateAiVaultJsonlLines } from './session-jsonl-line-reader'
import { withAiVaultWholeJsonFile } from './session-whole-json-reader'
import {
  addPreviewContent,
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  kimiPrimaryAgentWirePath,
  kimiSessionIdFromStatePath,
  kimiSessionIndexPathFromStatePath,
  readKimiWorkDirForSessionId
} from './session-scanner-kimi-paths'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  asRecord,
  extractContentText,
  extractString,
  normalizePreviewText,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

// The rendered preview is 220 chars; this also covers hidden-context close-tag scanning.
const KIMI_ASSISTANT_PREVIEW_SOURCE_MAX_CHARS = 512 * 1024
const KIMI_ASSISTANT_PREVIEW_CHUNK_MAX = 256

type KimiAssistantPreviewBuffer = {
  chunks: string[]
  charCount: number
}

// Parses a Kimi Code `state.json` plus its sibling `agents/<id>/wire.jsonl`
// transcript into an AI Vault session. Metadata (title, timestamps, last prompt)
// comes from state.json; the work directory comes from the top-level
// session_index.jsonl; model/messages/tokens come from the wire transcript.
export async function parseKimiSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  let metadata: {
    title: string | null
    fallbackTitle: string | null
    createdAt: string | null
    updatedAt: string | null
    wirePath: string
  } | null
  try {
    metadata = await withAiVaultWholeJsonFile(file.path, (content) => {
      const stateRecord = parseJsonObject(content)
      return stateRecord
        ? {
            title: normalizeTitleText(extractString(stateRecord.title) ?? ''),
            fallbackTitle: normalizeTitleText(extractString(stateRecord.lastPrompt) ?? ''),
            createdAt: extractString(stateRecord.createdAt),
            updatedAt: extractString(stateRecord.updatedAt),
            wirePath: kimiPrimaryAgentWirePath(file.path, stateRecord)
          }
        : null
    })
  } catch {
    return null
  }
  if (!metadata) {
    return null
  }

  const sessionId = kimiSessionIdFromStatePath(file.path)
  const accumulator = createAccumulator({ agent: 'kimi', file, sessionId })

  // Why: Kimi sessions are work-dir-scoped — the resume command must `cd` into
  // the original directory or the CLI rejects it. That path lives only in the
  // top-level session_index.jsonl, keyed by the (prefixed) session id.
  accumulator.cwd = await readKimiWorkDirForSessionId(
    kimiSessionIndexPathFromStatePath(file.path),
    sessionId
  )

  accumulator.title = metadata.title
  accumulator.fallbackTitle = metadata.fallbackTitle
  updateTimeline(accumulator, metadata.createdAt)
  updateTimeline(accumulator, metadata.updatedAt)

  await consumeKimiWireTranscript(accumulator, metadata.wirePath)

  return finalizeSession(accumulator, platform)
}

async function consumeKimiWireTranscript(
  accumulator: SessionAccumulator,
  wirePath: string
): Promise<void> {
  const pendingAssistantText: KimiAssistantPreviewBuffer = { chunks: [], charCount: 0 }
  const flushAssistant = (): void => {
    // Why: previews use the 220-char limit (normalizePreviewText), not the
    // 96-char title limit — assistant replies are shown in full preview width
    // like every other agent's. Join raw chunks first so inter-chunk spacing
    // survives; normalizePreviewText then collapses whitespace and caps length.
    const text = normalizePreviewText(pendingAssistantText.chunks.join(''))
    pendingAssistantText.chunks = []
    pendingAssistantText.charCount = 0
    if (text) {
      accumulator.messageCount++
      addPreviewMessage(accumulator, { role: 'assistant', text })
    }
  }

  try {
    const lines = iterateAiVaultJsonlLines(wirePath)
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      switch (record.type) {
        case 'config.update':
          accumulator.model = extractString(record.modelAlias) ?? accumulator.model
          break
        case 'usage.record':
          accumulator.model = extractString(record.model) ?? accumulator.model
          accumulator.totalTokens += kimiUsageTotal(record.usage, record.usageScope)
          break
        case 'context.append_message':
          consumeKimiUserMessage(accumulator, record.message)
          break
        case 'context.append_loop_event':
          consumeKimiLoopEvent(record.event, pendingAssistantText, flushAssistant)
          break
        default:
          break
      }
    }
  } catch {
    // No transcript yet (session created but never ran a turn) — metadata-only
    // sessions still belong in the panel.
  }
  flushAssistant()
}

function consumeKimiUserMessage(accumulator: SessionAccumulator, value: unknown): void {
  const message = asRecord(value)
  // Why: only real user turns count. Kimi injects synthetic `role: "user"`
  // messages (origin.kind === "injection") for system reminders like the
  // auto-permission notice; those are not user activity.
  if (!message || message.role !== 'user' || asRecord(message.origin)?.kind !== 'user') {
    return
  }
  accumulator.messageCount++
  // Title uses the 96-char title limit; the preview uses the 220-char limit.
  accumulator.title ??= extractContentText(message.content)
  addPreviewContent(accumulator, 'user', message.content)
}

function consumeKimiLoopEvent(
  value: unknown,
  pendingAssistantText: KimiAssistantPreviewBuffer,
  flushAssistant: () => void
): void {
  const event = asRecord(value)
  if (!event) {
    return
  }
  if (event.type === 'content.part') {
    const part = asRecord(event.part)
    // Push the raw chunk text; flushAssistant normalizes the joined result so
    // multi-chunk spacing is not lost to per-chunk trimming.
    if (part?.type === 'text' && typeof part.text === 'string') {
      appendKimiAssistantPreviewText(pendingAssistantText, part.text)
    }
    return
  }
  // A step end closes one assistant turn; flush its accumulated text as a single
  // preview message so streamed `content.part` chunks collapse into one entry.
  if (event.type === 'step.end') {
    flushAssistant()
  }
}

function appendKimiAssistantPreviewText(buffer: KimiAssistantPreviewBuffer, text: string): void {
  const remaining = KIMI_ASSISTANT_PREVIEW_SOURCE_MAX_CHARS - buffer.charCount
  if (remaining <= 0 || text.length === 0) {
    return
  }
  const retained = text.length <= remaining ? text : text.slice(0, remaining)
  buffer.chunks.push(retained)
  buffer.charCount += retained.length
  if (buffer.chunks.length >= KIMI_ASSISTANT_PREVIEW_CHUNK_MAX) {
    buffer.chunks = [buffer.chunks.join('')]
  }
}

// Kimi reports per-turn usage as {inputOther, output, inputCacheRead,
// inputCacheCreation}; sum all four for a session total. Skip any future
// cumulative ("session"-scoped) record so turn deltas are not double-counted.
function kimiUsageTotal(value: unknown, usageScope: unknown): number {
  if (usageScope === 'session') {
    return 0
  }
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  return (
    numberValue(usage.inputOther) +
    numberValue(usage.output) +
    numberValue(usage.inputCacheRead) +
    numberValue(usage.inputCacheCreation)
  )
}
