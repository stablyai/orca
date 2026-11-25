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
  /** The turn a credential retry failed, and its row; another turn never reads it. */
  private authFailure: { turnId: string; row: ClaudeFailureRow } | null = null
  constructor(
    private readonly account?: () => AgentSessionAccountKind | undefined,
    private readonly model?: () => string | undefined
  ) {}

  assistant(message: Record<string, unknown>) {
    const notice = this.notice(message)
    // Claude ended the turn on its own credential error first: the retry's row says which (a 403
    // is also labelled authentication_failed), and the result has nothing left to add.
    const pending =
      notice && isRootClaudeFrame(message) && message.error === 'authentication_failed'
        ? this.authFailure
        : null
    if (pending) {
      this.authFailure = null
    }
    const row = pending?.row ?? notice
    if (row) {
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
  authRetry(message: Record<string, unknown>, turnId: string | null): void {
    const status = claudeAuthRetryStatus(message)
    // Without an open turn there is no result to end, so nothing waits on this retry.
    if (status === null || turnId === null) {
      return
    }
    const detail = providerDiagnostic(claudeText(message.error) ?? `HTTP ${status}`, 'person')
    if (this.authFailure?.turnId !== turnId) {
      this.authFailure = {
        turnId,
        // A 403 is also an access denial, so only a 401 earns sign-in guidance.
        row: this.failureRow(status === 401 ? 'notSignedIn' : 'providerResponseFailed', detail)
      }
    }
  }

  /** The failure an auth retry left for the result that ends its turn, read once. */
  takeAuthFailure(turnId: string | null): ClaudeFailureRow | null {
    const failure = this.authFailure
    this.authFailure = null
    return turnId !== null && failure?.turnId === turnId ? failure.row : null
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
