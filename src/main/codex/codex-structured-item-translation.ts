import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { CodexTurnOrdinals } from './codex-turn-ordinals'
export {
  CodexTurnOrdinals,
  MAX_CODEX_TURN_ORDINAL_BYTES,
  MAX_CODEX_TURN_ORDINAL_ENTRIES
} from './codex-turn-ordinals'

// Codex thread items → journal item bodies and durable identities.
//
// THE ORDINAL RULE, and why it is not "index within the turn". Codex renumbers
// item ids positionally on resume (`item-1`…`item-N` across the whole thread),
// and a resumed turn does NOT contain every item the live turn emitted —
// reasoning and command execution are dropped from persisted history. Numbering
// by live position would therefore shift every message after the first tool
// call and hand the user a duplicate of the assistant's answer after a resume.
//
// So the ordinal counts MESSAGE items only, and the same projection is applied
// to the live stream and to a resumed turn's item list. Any other item type —
// including ones this build does not model — is skipped identically on both
// sides, which is what makes the key survive a Codex release that adds one.

/** Only these carry a durable `(threadId, turnId, ordinal)` identity. */
const CODEX_MESSAGE_ITEM_TYPES = new Set(['userMessage', 'agentMessage'])

export type CodexThreadItem = {
  type: string
  id: string
  [key: string]: unknown
}

export function isCodexMessageItemType(type: string): boolean {
  return CODEX_MESSAGE_ITEM_TYPES.has(type)
}

export function readCodexThreadItem(value: unknown): CodexThreadItem | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  return typeof record.type === 'string' && typeof record.id === 'string'
    ? (record as CodexThreadItem)
    : null
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * Durable identity for a Codex item, or null for one that has none.
 *
 * Non-message items fall back to the `orca` namespace keyed by the Codex item
 * id. That id is unstable across resume, so those rows are live-session detail
 * that a recovered journal simply will not contain — which is correct: Codex
 * itself does not persist them either.
 */
export function codexItemIdentity(input: {
  threadId: string
  turnId: string | null
  item: CodexThreadItem
  ordinals: CodexTurnOrdinals
}): AgentJournalItemIdentity {
  const { item, turnId } = input
  if (turnId && isCodexMessageItemType(item.type)) {
    return {
      provider: 'codex',
      threadId: input.threadId,
      turnId,
      ordinal: input.ordinals.ordinalFor(input.threadId, turnId, item.id)
    }
  }
  return { provider: 'orca', clientMessageId: `codex-item:${input.threadId}:${item.id}` }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readString(source, key)
    if (value !== null) {
      return value
    }
  }
  return null
}

function readTextContent(source: Record<string, unknown>, key: string): string | null {
  const direct = readString(source, key)
  if (direct) {
    return direct
  }
  const value = source[key]
  if (!Array.isArray(value)) {
    return null
  }
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') {
      return part.length > 0 ? [part] : []
    }
    if (typeof part !== 'object' || part === null) {
      return []
    }
    const text = readString(part as Record<string, unknown>, 'text')
    return text ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n') : null
}

/** `userMessage` carries structured content parts; `agentMessage` a flat text. */
export function codexMessageBlocks(item: CodexThreadItem): NativeChatBlock[] {
  const text =
    item.type === 'agentMessage'
      ? (readString(item, 'text') ?? readTextContent(item, 'content'))
      : readString(item, 'text')
  if (text !== null) {
    return [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
  }
  const content = item.content
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const partText = readString(part as Record<string, unknown>, 'text')
    if (partText !== null) {
      blocks.push({
        type: 'text',
        text: boundInlineText(partText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      })
      continue
    }
    const record = part as Record<string, unknown>
    if (record.type === 'image' && typeof record.url === 'string') {
      blocks.push({ type: 'image-ref', url: record.url })
    } else if (record.type === 'localImage' && typeof record.path === 'string') {
      blocks.push({ type: 'image-ref', path: record.path })
    }
  }
  return blocks
}

/** Codex reports `inProgress` then a terminal status; a zero exit code is the
 *  only thing that makes a finished command a success. */
function commandState(item: CodexThreadItem): 'running' | 'completed' | 'failed' {
  const status = readString(item, 'status')
  if (status === null || status === 'inProgress') {
    return 'running'
  }
  if (status !== 'completed') {
    return 'failed'
  }
  const exitCode = item.exitCode
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed'
}

export type CodexJournalItem = {
  body: AgentJournalItemBody | null
  blobs: { digest: string; payload: string }[]
  handled: boolean
}

function commandItem(item: CodexThreadItem): CodexJournalItem {
  const output = readFirstString(item, ['aggregatedOutput', 'aggregated_output'])
  const bounded = output === null ? null : boundInlineText(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    body: {
      kind: 'tool-call',
      name: 'shell',
      input: boundToolInput(
        { command: item.command ?? null, cwd: item.cwd ?? null },
        DEFAULT_JOURNAL_PAYLOAD_LIMITS
      ),
      state: commandState(item),
      ...(bounded === null ? {} : { output: bounded.bounded })
    },
    blobs:
      output !== null && bounded?.bounded.truncated
        ? [{ digest: bounded.bounded.digest, payload: output }]
        : [],
    handled: true
  }
}

function fileChangeItem(item: CodexThreadItem): CodexJournalItem {
  const changes = Array.isArray(item.changes)
    ? item.changes.flatMap((change) => {
        const record = typeof change === 'object' && change !== null ? readRecord(change) : {}
        const path = readString(record, 'path')
        const diff = readString(record, 'diff')
        return path && diff ? [{ path, diff }] : []
      })
    : []
  if (changes.length === 0) {
    return {
      body: {
        kind: 'tool-call',
        name: 'apply_patch',
        input: boundToolInput({ changes: item.changes ?? null }, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
        state: commandState(item)
      },
      blobs: [],
      handled: true
    }
  }
  const patch = changes.map((change) => change.diff).join('\n')
  const bounded = boundInlineText(patch, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
  return {
    body: {
      kind: 'diff',
      path: changes.length === 1 ? changes[0]!.path : `${changes.length} files`,
      patch: bounded
    },
    blobs: bounded.truncated ? [{ digest: bounded.digest, payload: patch }] : [],
    handled: true
  }
}

/**
 * Journal body for a Codex item, or null for one with nothing to render.
 *
 * Known empty items wait for later deltas. Unknown types become bounded status
 * rows so a provider release cannot make new activity invisible.
 */
export function codexJournalItem(item: CodexThreadItem): CodexJournalItem {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const blocks = codexMessageBlocks(item)
    return {
      body:
        blocks.length === 0
          ? null
          : { kind: 'message', role: item.type === 'userMessage' ? 'user' : 'assistant', blocks },
      blobs: [],
      handled: true
    }
  }
  if (item.type === 'commandExecution') {
    return commandItem(item)
  }
  if (item.type === 'fileChange') {
    return fileChangeItem(item)
  }
  if (item.type === 'reasoning' || item.type === 'plan') {
    const text =
      readTextContent(item, 'text') ??
      readTextContent(item, 'summary') ??
      readTextContent(item, 'content')
    return {
      body:
        text === null
          ? null
          : { kind: 'status', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text },
      blobs: [],
      handled: true
    }
  }
  const unhandled = unhandledProviderFrameJournalItem('codex', `item:${item.type}`, item)
  return unhandled
    ? { body: unhandled.body, blobs: unhandled.blobs, handled: false }
    : { body: null, blobs: [], handled: true }
}

export function codexItemBody(item: CodexThreadItem): AgentJournalItemBody | null {
  return codexJournalItem(item).body
}

/** Snapshot body for text still streaming, before its item completes. */
export function codexStreamingMessageBody(text: string): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
  }
}

/** Snapshot body for any item-level stream, keyed onto its parent item. */
export function codexStreamingJournalItem(item: CodexThreadItem, text: string): CodexJournalItem {
  if (item.type === 'agentMessage') {
    return { body: codexStreamingMessageBody(text), blobs: [], handled: true }
  }
  if (item.type === 'commandExecution') {
    return commandItem({ ...item, aggregatedOutput: text })
  }
  if (item.type === 'fileChange') {
    const path = Array.isArray(item.changes)
      ? readString(readRecord(item.changes[0]), 'path')
      : null
    const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
    return {
      body: { kind: 'diff', path: path ?? 'pending patch', patch: bounded },
      blobs: bounded.truncated ? [{ digest: bounded.digest, payload: text }] : [],
      handled: true
    }
  }
  const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return { body: { kind: 'status', text: bounded.text }, blobs: [], handled: true }
}
