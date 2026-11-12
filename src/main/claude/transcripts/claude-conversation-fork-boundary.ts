import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { AgentConversationCopyError } from '../../native-chat/agent-conversation-copy-error'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { decodeClaudeTranscriptLine } from '../../native-chat/transcript-line-decoders-claude'
import { isLocalCommandCaveatRow } from './claude-rewind-fork'
import { claudeSourceBlockId } from '../structured/journal/claude-streamed-block-identity'
import { isClaudeTranscriptRootPrompt } from './claude-transcript-root-prompt'
import {
  claudeRecord,
  claudeToolUses,
  claudeToolResults,
  readClaudeMessageEnvelope
} from '../structured/journal/claude-structured-item-translation'
import { claudeTranscriptPrompt } from './claude-transcript-prompt'

export type ClaudeForkCheckpoint = NonNullable<
  Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]['checkpoint']
>

export function isClaudeConversationEntry(
  row: Record<string, unknown>
): row is Record<string, unknown> & { uuid: string } {
  return (
    typeof row.uuid === 'string' &&
    row.isSidechain !== true &&
    row.parent_tool_use_id == null &&
    (row.type === 'user' ||
      row.type === 'assistant' ||
      row.type === 'attachment' ||
      (row.type === 'system' && typeof row.parentUuid === 'string'))
  )
}

/** Full native traversal belongs in the worker, independently of catch-up's suffix budget. */
export function claudeConversationForkBoundary(
  entries: SessionStoreEntry[],
  checkpoint: ClaudeForkCheckpoint
): string {
  const unavailable = (): never => {
    throw new AgentConversationCopyError(
      'Claude could not find the saved context for this response. Open the source chat and try again.'
    )
  }
  const byUuid = new Map<string, Record<string, unknown>>()
  let newest: Record<string, unknown> | undefined
  for (const entry of entries) {
    const row = claudeRecord(entry)
    if (
      typeof row?.uuid === 'string' &&
      row.isSidechain !== true &&
      row.parent_tool_use_id == null
    ) {
      byUuid.set(row.uuid, row)
      if (
        row.type === 'user' ||
        row.type === 'assistant' ||
        row.type === 'attachment' ||
        (row.type === 'system' && typeof row.parentUuid === 'string')
      ) {
        newest = row
      }
    }
  }
  const chain: Record<string, unknown>[] = []
  for (
    let row = checkpoint.beforeMessage ? byUuid.get(checkpoint.beforeMessage.uuid) : newest;
    row;
  ) {
    chain.push(row)
    byUuid.delete(String(row.uuid))
    const parent = typeof row.parentUuid === 'string' ? row.parentUuid : row.logicalParentUuid
    row = typeof parent === 'string' ? byUuid.get(parent) : undefined
  }
  chain.reverse()
  const boundaryHasCallerResults = (end: number): boolean => {
    const boundary = chain[end]
    if (!boundary) {
      return false
    }
    const envelope = readClaudeMessageEnvelope({ ...boundary, session_id: boundary.sessionId })
    if (
      !envelope ||
      !claudeTranscriptPrompt(boundary, envelope, String(boundary.sessionId)).internalTurnStart
    ) {
      return false
    }
    const calls = new Set<string>()
    for (let index = end - 1; index >= 0; index -= 1) {
      const row = chain[index]!
      if (isClaudeTranscriptRootPrompt(row)) {
        break
      }
      const caller = readClaudeMessageEnvelope({ ...row, session_id: row.sessionId })
      if (caller?.role === 'assistant') {
        for (const tool of claudeToolUses(caller)) {
          calls.add(tool.id)
        }
      }
    }
    return claudeToolResults(envelope).some((result) => calls.has(result.toolUseId))
  }
  if (checkpoint.beforeMessage) {
    let next = chain.findIndex((row) => row.uuid === checkpoint.beforeMessage?.uuid)
    if (boundaryHasCallerResults(next)) {
      return String(chain[next]!.uuid)
    }
    while (next > 0 && isLocalCommandCaveatRow(chain[next - 1]!)) {
      next -= 1
    }
    return next > 0 ? String(chain[next - 1]!.uuid) : unavailable()
  }
  const selected = chain.findIndex((row) => {
    const message = claudeRecord(row.message)
    return (
      row.uuid === checkpoint.throughMessage?.uuid ||
      (typeof message?.id === 'string' &&
        typeof row.apiBlockIndex === 'number' &&
        claudeSourceBlockId(message.id, row.apiBlockIndex) === checkpoint.throughMessage?.uuid)
    )
  })
  const opener = checkpoint.rootMessage
    ? chain.findIndex(
        (row) => row.uuid === checkpoint.rootMessage?.uuid && isClaudeTranscriptRootPrompt(row)
      )
    : -1
  if (selected === -1 && (opener === -1 || !checkpoint.settled)) {
    return unavailable()
  }
  const start = opener !== -1 ? opener : selected
  if (selected !== -1 && selected < start) {
    return unavailable()
  }
  const next = chain.findIndex((row, index) => index > start && isClaudeTranscriptRootPrompt(row))
  // Import settles caller-owned results before the hidden task boundary.
  const root = chain.slice(
    start,
    next === -1 ? undefined : next + (boundaryHasCallerResults(next) ? 1 : 0)
  )
  const endpoint = root.findLast((row) => {
    if (row.type === 'assistant' || row.type === 'user') {
      return !isLocalCommandCaveatRow(row)
    }
    return (
      row.type === 'attachment' &&
      decodeClaudeTranscriptLine(JSON.stringify(row), String(row.uuid))?.role === 'user'
    )
  })
  const message = claudeRecord(endpoint?.message)
  const terminalStop =
    endpoint?.type === 'assistant' &&
    ['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(String(message?.stop_reason)) &&
    (!Array.isArray(message?.content) ||
      !message.content.some((part) => claudeRecord(part)?.type === 'tool_use'))
  if (
    !checkpoint.settled &&
    next === -1 &&
    !terminalStop &&
    !root.some((row) => row.type === 'system' && row.subtype === 'turn_duration')
  ) {
    throw new AgentConversationCopyError(
      "Claude hasn't finished this response yet. Wait for it to finish, then try again."
    )
  }
  return typeof endpoint?.uuid === 'string' ? endpoint.uuid : unavailable()
}
