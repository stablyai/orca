import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureRowWords
} from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/failures/agent-session-availability'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'

/** A root api_retry for a rejected credential: waiting never clears a 401 or 403, so Orca stops it. */
export function claudeAuthRetryStatus(message: Record<string, unknown>): 401 | 403 | null {
  if (message.type !== 'system' || message.subtype !== 'api_retry' || !isRootClaudeFrame(message)) {
    return null
  }
  return message.error_status === 401 || message.error_status === 403 ? message.error_status : null
}

type ClaudeFailureRow = AgentSessionFailureRowWords & { kind: 'status'; tone: 'error' }

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAssistantFailures {
  private readonly shown = new BoundedMap<string, string | null>({ maxEntries: 128 })
  private authFailure: ClaudeFailureRow | null = null
  constructor(
    private readonly account?: () => AgentSessionAccountKind | undefined,
    private readonly model?: () => string | undefined
  ) {}

  assistant(message: Record<string, unknown>) {
    const row = this.notice(message)
    if (row) {
      // Claude ended the turn on its own credential error first; its row is the one.
      this.authFailure = null
      this.shown.set(this.scopeKey(message), claudeText(message.user_message_uuid))
    } else if (message.type === 'user' || message.type === 'assistant') {
      this.shown.delete(this.scopeKey(message))
    }
    return row
  }

  /** Classify without recording it as shown; a caller that keeps the row must write it. */
  notice(message: Record<string, unknown>) {
    const unavailable =
      message.error === 'model_not_found' && (message.parent_tool_use_id ?? null) === null
    if (
      message.type !== 'assistant' ||
      (!unavailable && message.error !== 'authentication_failed')
    ) {
      return null
    }
    const content = claudeRecord(message.message)?.content
    const text = Array.isArray(content)
      ? content
          .flatMap((part) => {
            const value = claudeRecord(part)
            return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
          })
          .join('\n')
      : ''
    return unavailable
      ? this.failureRow(
          'modelUnavailable',
          providerDiagnostic(this.model?.() ?? 'this model', 'log')
        )
      : this.failureRow('notSignedIn', providerDiagnostic(text, 'person'))
  }

  /** Record a turn's first credential retry; its result ends the turn with this failure. */
  authRetry(message: Record<string, unknown>): boolean {
    const status = claudeAuthRetryStatus(message)
    if (status === null) {
      return false
    }
    const detail = providerDiagnostic(claudeText(message.error) ?? `HTTP ${status}`, 'person')
    // A 403 is also an access denial, so only a 401 earns sign-in guidance.
    this.authFailure ??= this.failureRow(
      status === 401 ? 'notSignedIn' : 'providerResponseFailed',
      detail
    )
    return true
  }

  /** The failure an auth retry left for the result that ends its turn, read once. */
  takeAuthFailure(): ClaudeFailureRow | null {
    const failure = this.authFailure
    this.authFailure = null
    return failure
  }

  private failureRow(
    kind: 'modelUnavailable' | 'notSignedIn' | 'providerResponseFailed',
    detail: ReturnType<typeof providerDiagnostic>
  ): ClaudeFailureRow {
    return {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(
        agentSessionFailureFact(kind, {
          account: this.account?.(),
          detail
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }

  resultAlreadyShown(message: Record<string, unknown>): boolean {
    const key = this.scopeKey(message)
    const shownUuid = this.shown.get(key)
    if (shownUuid === undefined) {
      return false
    }
    this.shown.delete(key)
    const resultUuids = Array.isArray(message.user_message_uuids)
      ? message.user_message_uuids.filter(
          (uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0
        )
      : []
    const resultUuid = claudeText(message.user_message_uuid)
    if (resultUuid) {
      resultUuids.push(resultUuid)
    }
    return (
      message.is_error === true &&
      (!shownUuid || resultUuids.length === 0 || resultUuids.includes(shownUuid))
    )
  }

  private scopeKey(message: Record<string, unknown>): string {
    return JSON.stringify([message.session_id, message.parent_tool_use_id ?? null])
  }
}
