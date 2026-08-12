// Why: translates opencode2 service events into the opencode-family hook event
// vocabulary the shared listener already normalizes (SessionBusy/Idle,
// MessagePart, PermissionRequest). Pure module so translation is unit-testable
// without a live service; the watcher lifecycle lives in hook-service.ts.

import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type AgentType,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { readOpenCode2RecordString } from './sse-consumer'

export type OpenCode2FamilyEvent =
  | 'SessionBusy'
  | 'SessionIdle'
  | 'MessagePart'
  | 'PermissionRequest'

export type OpenCode2TranslatedEvent = {
  familyEvent: OpenCode2FamilyEvent
  role?: 'user' | 'assistant'
  text?: string
}

/** Normalize a translated event into the status payload the hook server ingests. */
export function buildOpenCode2StatusPayload(
  translated: OpenCode2TranslatedEvent,
  prompt: string | undefined
): ParsedAgentStatusPayload | null {
  const state: AgentStatusState =
    translated.familyEvent === 'SessionIdle'
      ? 'done'
      : translated.familyEvent === 'PermissionRequest'
        ? 'waiting'
        : 'working'
  return normalizeAgentStatusPayload({
    state,
    ...(prompt ? { prompt } : {}),
    agentType: 'opencode2' as AgentType,
    ...(translated.role === 'assistant' && translated.text
      ? { lastAssistantMessage: translated.text }
      : {})
  })
}

const WORKING_EVENTS = new Set(['session.execution.started', 'session.step.started'])
const IDLE_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted'
])
const TEXT_EVENTS = new Set(['session.text.started', 'session.text.delta', 'session.text.ended'])
const TOOL_EVENTS = new Set(['session.tool.input.started', 'session.tool.called'])
const WAITING_EVENTS = new Set(['permission.asked', 'question.asked', 'form.created'])
const USER_PROMPT_EVENTS = new Set(['session.input.promoted', 'session.input.admitted'])

/**
 * Accumulates streaming text fragments per assistant message so `text.ended`
 * can deliver the full reply even when intermediate deltas were throttled.
 * Bounded: entry count and per-entry length are capped so a never-ending
 * stream cannot grow the map without bound.
 */
export class OpenCode2TextAccumulator {
  private readonly pending = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxEntryChars: number

  constructor(maxEntries = 64, maxEntryChars = 64_000) {
    this.maxEntries = maxEntries
    this.maxEntryChars = maxEntryChars
  }

  append(messageId: string, delta: string): void {
    if (this.pending.size >= this.maxEntries && !this.pending.has(messageId)) {
      const oldest = this.pending.keys().next().value
      if (typeof oldest === 'string') {
        this.pending.delete(oldest)
      }
    }
    const next = `${this.pending.get(messageId) ?? ''}${delta}`
    this.pending.set(messageId, next.slice(0, this.maxEntryChars))
  }

  take(messageId: string): string | null {
    const text = this.pending.get(messageId) ?? null
    this.pending.delete(messageId)
    return text
  }
}

export function translateOpenCode2Event(
  event: string,
  record: Record<string, unknown>,
  textAccumulator: OpenCode2TextAccumulator
): OpenCode2TranslatedEvent | null {
  if (event === 'session.status') {
    const status =
      record.status && typeof record.status === 'object'
        ? readOpenCode2RecordString(record.status as Record<string, unknown>, 'type')
        : null
    if (status === 'idle') {
      return { familyEvent: 'SessionIdle' }
    }
    if (status === 'busy' || status === 'retry') {
      return { familyEvent: 'SessionBusy' }
    }
    return null
  }
  if (WORKING_EVENTS.has(event)) {
    return { familyEvent: 'SessionBusy' }
  }
  if (IDLE_EVENTS.has(event)) {
    return { familyEvent: 'SessionIdle' }
  }
  if (TEXT_EVENTS.has(event)) {
    const assistantMessageId = readOpenCode2RecordString(record, 'assistantMessageID')
    let text: string | null = null
    if (event === 'session.text.delta') {
      const delta = readOpenCode2RecordString(record, 'delta')
      if (delta && assistantMessageId) {
        textAccumulator.append(assistantMessageId, delta)
      }
      text = delta
    } else if (event === 'session.text.ended') {
      const accumulated = assistantMessageId ? textAccumulator.take(assistantMessageId) : null
      text = readOpenCode2RecordString(record, 'text') ?? accumulated
    }
    return { familyEvent: 'MessagePart', role: 'assistant', ...(text ? { text } : {}) }
  }
  if (TOOL_EVENTS.has(event)) {
    // Why: tool activity is a working ping without assistant text.
    return { familyEvent: 'MessagePart', role: 'assistant' }
  }
  if (WAITING_EVENTS.has(event)) {
    return { familyEvent: 'PermissionRequest' }
  }
  if (USER_PROMPT_EVENTS.has(event)) {
    const text = readOpenCode2RecordString(record, 'prompt')
    return { familyEvent: 'MessagePart', role: 'user', ...(text ? { text } : {}) }
  }
  return null
}
