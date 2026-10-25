import type {
  AgentJournalPlainStatusItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND } from '../../../shared/native-chat/native-chat-provider-frame-summary'
import {
  boundPayload,
  PROVIDER_FRAME_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../agent-session-journal/journal-payload-bounds'
import { codexGoalRowText, codexThreadGoalState } from '../../codex/codex-goal-journal-rows'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import { classifyProviderFrame } from './provider-frame-disposition'
import { hookOutcomeRowBody } from '../../../shared/agent-session-hook-outcome'

export type UnhandledProviderFrameJournalItem = {
  body: AgentJournalPlainStatusItem
  turnScope?: AgentJournalTurnScope
  /** Failures/warnings/hook refusals bypass timeline row caps. */
  classification: 'timeline-substantive' | 'error-surface'
}

export type UnhandledProviderFrameJournalItemOptions = {
  /** Translator-only facts decide failure, e.g. whether the user stopped a Claude result. */
  reportsFailure?: boolean
}

function serializeProviderPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload)
    return serialized === undefined ? String(payload) : serialized
  } catch (error) {
    return `[unserializable payload: ${error instanceof Error ? error.message : String(error)}]`
  }
}

/** Prefer specific human sentences, including one-level warning wrappers. */
const MESSAGE_KEYS = [
  'message',
  'text',
  'warning',
  'detail',
  'description',
  'reason',
  'error'
] as const

function directReadableMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim() || null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

export function readableProviderFrameText(payload: unknown): string | null {
  const direct = directReadableMessage(payload)
  if (direct || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return direct
  }
  const record = payload as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const nested = directReadableMessage(record[key])
    if (nested) {
      return nested
    }
  }
  return null
}

function hookText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

/** Prompt-hook refusals need rows; other hooks already surface through tool results. */
function codexHookOutcomeRow(payload: unknown): AgentJournalPlainStatusItem | null {
  const run = isProviderRecord(payload) && isProviderRecord(payload.run) ? payload.run : null
  const status = run?.eventName === 'userPromptSubmit' ? run.status : null
  const entries: unknown[] = Array.isArray(run?.entries) ? run.entries : []
  const details = entries.flatMap((entry) => {
    const text = isProviderRecord(entry) && entry.kind !== 'context' ? hookText(entry.text) : null
    return text ? [text] : []
  })
  return status === 'blocked' || status === 'stopped' ? hookOutcomeRowBody(status, details) : null
}

function hookFailureFrameText(
  provider: string,
  kind: string,
  payload: unknown,
  fallback: string | null
): string | null {
  if (!isProviderRecord(payload)) {
    return null
  }
  if (provider === 'codex' && kind === 'notification:hook/completed') {
    const run = isProviderRecord(payload.run) ? payload.run : null
    const event = hookText(run?.eventName)
    const name = event ? ` ${event.charAt(0).toUpperCase()}${event.slice(1)}` : ''
    const errors = Array.isArray(run?.entries)
      ? run.entries.flatMap((entry: unknown) => {
          const text =
            isProviderRecord(entry) && entry.kind === 'error' ? hookText(entry.text) : null
          return text ? [text] : []
        })
      : []
    const detail = errors.join('\n') || fallback
    return `Codex${name} hook failed${detail ? `: ${detail}` : '.'}`
  }
  if (provider === 'claude' && kind === 'message:system:hook_response') {
    const name = hookText(payload.hook_name) ?? hookText(payload.hook_event)
    const code = payload.exit_code
    const exit =
      typeof code === 'number' && Number.isSafeInteger(code) && code !== 0
        ? ` (exit code ${code})`
        : ''
    const detail =
      hookText(payload.stderr) ?? hookText(payload.output) ?? hookText(payload.stdout) ?? fallback
    return `Claude${name ? ` ${name}` : ''} hook failed${exit}${detail ? `: ${detail}` : '.'}`
  }
  return null
}

/** Keep readable fallback text whole; clients render only frames carrying a sentence. */
export function unhandledProviderFrameJournalItem(
  provider: string,
  kind: string,
  payload: unknown,
  limits: JournalPayloadLimits = PROVIDER_FRAME_PAYLOAD_LIMITS,
  options: UnhandledProviderFrameJournalItemOptions = {}
): UnhandledProviderFrameJournalItem | null {
  // Match native warning rows: uncapped, without raw-frame disclosure.
  const hook =
    provider === 'codex' && kind === 'notification:hook/completed'
      ? codexHookOutcomeRow(payload)
      : null
  if (hook) {
    return {
      body: hook,
      classification: 'error-surface',
      // Refused Codex prompts are never echoed, so no message can anchor this row.
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  }
  const classification =
    options.reportsFailure === true
      ? 'error-surface'
      : classifyProviderFrame(provider, kind, payload)
  if (
    classification === 'stream-into-item' ||
    classification === 'status-chrome' ||
    classification === 'suppressed-benign'
  ) {
    return null
  }
  const serialized = serializeProviderPayload(payload)
  const bounded = boundPayload(serialized, limits)
  // Lead with the provider sentence; raw opcodes are unreadable protocol noise.
  const method = kind.startsWith('notification:') ? kind.slice('notification:'.length) : kind
  const compaction =
    provider === 'codex' && (method === 'thread/compacted' || method === 'item:contextCompaction')
  const noticeTone =
    provider === 'codex'
      ? method === 'deprecationNotice'
        ? 'notice'
        : ['warning', 'guardianWarning', 'configWarning'].includes(method)
          ? 'warning'
          : undefined
      : undefined
  const tone = noticeTone ?? (classification === 'error-surface' ? 'error' : undefined)
  let message = readableProviderFrameText(payload)
  if (classification === 'error-surface') {
    message = hookFailureFrameText(provider, kind, payload, message) ?? message
  }
  if (
    provider === 'codex' &&
    (method === 'configWarning' || method === 'deprecationNotice') &&
    typeof payload === 'object' &&
    payload !== null
  ) {
    const record = payload as Record<string, unknown>
    message =
      [record.summary, record.details]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n') || message
  }
  if (provider === 'claude' && kind === CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND) {
    const content =
      typeof payload === 'object' && payload !== null && 'content' in payload
        ? payload.content
        : null
    message = typeof content === 'string' && content.trim() ? content.trim() : message
  }
  const goalText = provider === 'codex' ? codexGoalRowText(method, payload) : null
  const threadGoal = provider === 'codex' ? codexThreadGoalState(method, payload) : null
  return {
    body: {
      kind: 'status',
      text: compaction ? 'Context compacted' : goalText || message || `${provider} · ${kind}`,
      ...(compaction ? { presentation: 'compaction' } : {}),
      ...(tone ? { tone } : {}),
      providerFrame: { provider, kind, payload: bounded },
      ...(threadGoal ? { threadGoal } : {})
    },
    classification: classification === 'error-surface' ? 'error-surface' : 'timeline-substantive'
  }
}
