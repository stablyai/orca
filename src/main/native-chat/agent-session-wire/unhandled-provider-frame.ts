import type { AgentJournalPlainStatusItem } from '../../../shared/agent-session-journal-types'
import { CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND } from '../../../shared/native-chat-provider-frame-summary'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../agent-session-journal/journal-payload-bounds'
import { codexGoalRowText, codexThreadGoalState } from '../../codex/codex-goal-journal-rows'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import { classifyProviderFrame } from './provider-frame-disposition'

export type UnhandledProviderFrameJournalItem = {
  body: AgentJournalPlainStatusItem
  /** Why the frame surfaced. Error frames are exempt from generic-row caps. */
  classification: 'timeline-substantive' | 'error-surface'
}

export type UnhandledProviderFrameJournalItemOptions = {
  /** The caller's own translator judged this frame a failure, from facts its kind alone cannot
   *  carry (a Claude result is one only when its turn was not stopped by the user). */
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

/** Fields providers use for the human-facing sentence on a frame, most specific
 *  first. Nested one level because warnings arrive wrapped as often as not. */
const MESSAGE_KEYS = [
  'message',
  'text',
  'warning',
  'detail',
  'description',
  'reason',
  // Where a failure frame keeps its sentence (Codex's `error` nests it as `error.message`).
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

/** The provider's own sentence for a frame, when it carries one. */
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

/** Substantive adapter fallbacks become bounded journal rows; a chat draws one only with a sentence. */
export function unhandledProviderFrameJournalItem(
  provider: string,
  kind: string,
  payload: unknown,
  limits: JournalPayloadLimits = DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  options: UnhandledProviderFrameJournalItemOptions = {}
): UnhandledProviderFrameJournalItem | null {
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
  // Why: the opcode alone ("codex · notification:warning") tells the user nothing
  // and reads as protocol noise. Lead with the provider's own sentence when it has
  // one; the raw frame stays behind the row's disclosure either way.
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
  // A local slash command's output (`/usage`) is the answer the user asked for; it rides `content`.
  if (provider === 'claude' && kind === CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND) {
    const content =
      typeof payload === 'object' && payload !== null && 'content' in payload
        ? payload.content
        : null
    message = typeof content === 'string' && content.trim() ? content.trim() : message
  }
  const goalText = provider === 'codex' ? codexGoalRowText(method, payload) : null
  const display = message ? boundInlineText(message, limits) : null
  const goalDisplay = goalText ? boundInlineText(goalText, limits) : null
  const threadGoal = provider === 'codex' ? codexThreadGoalState(method, payload) : null
  return {
    body: {
      kind: 'status',
      text: compaction
        ? 'Context compacted'
        : (goalDisplay?.text ?? display?.text ?? `${provider} · ${kind}`),
      ...(compaction ? { presentation: 'compaction' } : {}),
      ...(tone ? { tone } : {}),
      providerFrame: { provider, kind, payload: bounded },
      ...(threadGoal
        ? {
            threadGoal:
              threadGoal.state === 'set'
                ? {
                    state: 'set' as const,
                    goal: {
                      ...threadGoal.goal,
                      objective: boundInlineText(threadGoal.goal.objective, limits).text
                    }
                  }
                : threadGoal
          }
        : {})
    },
    classification: classification === 'error-surface' ? 'error-surface' : 'timeline-substantive'
  }
}
