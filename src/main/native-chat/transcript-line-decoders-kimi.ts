// Kimi Code wire.jsonl line → NativeChatMessage decoder.
//
// Layout: <KIMI_CODE_HOME>/sessions/wd_<name>_<hash>/session_<uuid>/agents/<id>/wire.jsonl.
// Records are typed envelopes (`{type, time, ...}`, epoch ms):
//
// - `turn.prompt` / `turn.steer` carry user input as `input[]` content parts.
//   Only `origin.kind === 'user'` is a real user turn; background_task,
//   cron_job and system_trigger steers are automation, not conversation.
// - `context.append_loop_event` wraps one agent-loop event. `content.part`
//   records are COMPLETE parts (one record per think/text block per step, not
//   streaming deltas), so per-line decoding stays stateless; `tool.call` /
//   `tool.result` pair on `toolCallId`; `step.begin` / `step.end` bracket a
//   step and carry no renderable content (the turn lifecycle decoder reads
//   step.end's finishReason).
// - `turn.cancel` marks an interruption, surfaced like Claude/Codex aborts.
//
// A rewind/resume appends the new branch without removing the old one, so the
// abandoned turns render too — the same stance the omp decoder documents for
// its tree-shaped file; unwinding needs a stateful contract shared by every
// agent, not a kimi-only workaround. Verified against real sessions: resumed
// files never re-log a record byte-identically (re-sent prompts are distinct
// turns with distinct times), but toolCallIds DO repeat across the rewind, so
// tool messages key on toolCallId + line anchor, never toolCallId alone.
//
// `context.append_message` is skipped entirely: it duplicates every real
// prompt (each `turn.prompt` lands there too) and adds synthetic `injection`
// rows (auto-permission notices and the like), so decoding it would double
// user bubbles and leak harness noise. `llm.request`, `usage.record`,
// `config.update`, `metadata`, `tools.*`, `mcp.*` and `permission.*` are
// bookkeeping and skipped, as is any unrecognized record type.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

export function decodeKimiTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const timestamp = parseTimestamp(record.time)
  switch (record.type) {
    case 'turn.prompt':
    case 'turn.steer':
      return decodeKimiUserTurn(record, fallbackId, timestamp)
    case 'turn.cancel':
      // Why: `target: 'queued'` means a queued prompt was withdrawn before it
      // ever ran (loopService.cancelQueuedTurn) — not an interrupted turn.
      if (extractString(record.target) === 'queued') {
        return null
      }
      return {
        id: fallbackId,
        role: 'system',
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
        timestamp,
        source: 'transcript'
      }
    case 'context.append_loop_event':
      return decodeKimiLoopEvent(record, fallbackId, timestamp)
    default:
      return null
  }
}

/** A user-origin prompt/steer; every other origin is harness automation. */
function decodeKimiUserTurn(
  record: Record<string, unknown>,
  fallbackId: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (extractString(asRecord(record.origin)?.kind) !== 'user') {
    return null
  }
  const blocks = kimiTextBlocks(record.input)
  return blocks.length === 0
    ? null
    : { id: fallbackId, role: 'user', blocks, timestamp, source: 'transcript' }
}

function decodeKimiLoopEvent(
  record: Record<string, unknown>,
  fallbackId: string,
  timestamp: number | null
): NativeChatMessage | null {
  const event = asRecord(record.event)
  if (!event) {
    return null
  }
  const turnId = extractString(event.turnId)
  switch (event.type) {
    case 'content.part': {
      const part = asRecord(event.part)
      // Why: think parts render as plain text, mirroring the omp decoder's
      // thinking mapping — the block model has no thinking variant.
      const kind = extractString(part?.type)
      const raw = kind === 'text' ? part?.text : kind === 'think' ? part?.think : null
      if (typeof raw !== 'string' || !raw.trim()) {
        return null
      }
      return {
        id: extractString(event.uuid) ?? fallbackId,
        role: 'assistant',
        blocks: [{ type: 'text', text: raw }],
        timestamp,
        source: 'transcript',
        ...(turnId ? { turnId } : {})
      }
    }
    case 'tool.call': {
      const toolCallId = extractString(event.toolCallId)
      return {
        // Why: toolCallId is a per-session counter that a rewind/resume RESTARTS
        // (Bash:36 reappears on the new branch), so it cannot key the message on
        // its own — the assembler dedups on id and would drop the re-executed
        // call. Anchor it to the line's offset-based fallback id.
        id: toolCallId ? `${toolCallId}:${fallbackId}` : fallbackId,
        role: 'assistant',
        blocks: [
          {
            type: 'tool-call',
            name: extractString(event.name) ?? 'tool',
            input: event.args ?? null
          }
        ],
        timestamp,
        source: 'transcript',
        ...(turnId ? { turnId } : {})
      }
    }
    case 'tool.result': {
      const result = asRecord(event.result)
      const toolCallId = extractString(event.toolCallId)
      const blocks: NativeChatBlock[] = [
        {
          type: 'tool-result',
          output: toolResultOutput(result?.output),
          ...(result?.isError === true ? { isError: true } : {})
        }
      ]
      return {
        // Why: same rewind hazard as tool.call, plus the id must differ from
        // the call it answers — both carry the same toolCallId.
        id: toolCallId ? `${toolCallId}:${fallbackId}:result` : fallbackId,
        role: 'tool',
        blocks,
        timestamp,
        source: 'transcript',
        ...(turnId ? { turnId } : {})
      }
    }
    default:
      return null
  }
}

/** Text blocks for a turn prompt/steer `input` array; unknown parts drop. */
function kimiTextBlocks(input: unknown): NativeChatBlock[] {
  if (typeof input === 'string') {
    return input.trim() ? [{ type: 'text', text: input }] : []
  }
  if (!Array.isArray(input)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of input) {
    const part = asRecord(item)
    if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) {
      continue
    }
    blocks.push({ type: 'text', text: part.text })
  }
  return blocks
}

/** `timestampMs` yields NaN for an unparsable value; the chat model wants null. */
function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
