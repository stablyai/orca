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

/** Claude refreshes a rejected login before its second attempt, and on a dead login it gives up
 *  itself after that attempt (`authentication_failed`, about 2 s). A 401 still retried at a
 *  third attempt is the blind retry loop, which never clears. */
const CLAUDE_BLIND_AUTH_RETRY_ATTEMPT = 3

/** A root api_retry for a credential no retry will fix: a 403 denial, or a 401 past Claude's refresh. */
export function claudeAuthRetryStatus(message: Record<string, unknown>): 401 | 403 | null {
  if (message.type !== 'system' || message.subtype !== 'api_retry' || !isRootClaudeFrame(message)) {
    return null
  }
  if (message.error_status === 403) {
    return 403
  }
  const attempt = typeof message.attempt === 'number' ? message.attempt : 0
  return message.error_status === 401 && attempt >= CLAUDE_BLIND_AUTH_RETRY_ATTEMPT ? 401 : null
}

type ClaudeFailureRow = AgentSessionFailureRowWords & { kind: 'status'; tone: 'error' }

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAssistantFailures {
  private readonly shown = new BoundedMap<string, string | null>({ maxEntries: 128 })
  /** The turn a credential retry failed, and its row; another turn never reads it. */
  private authFailure: { turnId: string; row: ClaudeFailureRow; shown: boolean } | null = null
  constructor(
    private readonly account?: () => AgentSessionAccountKind | undefined,
    private readonly model?: () => string | undefined
  ) {}

  assistant(message: Record<string, unknown>, turnId: string | null) {
    const notice = this.notice(message)
    // Claude ended this turn on its own credential error first: the retry's row says which (a 403
    // is also labelled authentication_failed), and the result has nothing left to add.
    // It stays pending, shown, so the turn's result still settles it as a failure.
    const pending =
      notice &&
      isRootClaudeFrame(message) &&
      message.error === 'authentication_failed' &&
      turnId !== null &&
      this.authFailure?.turnId === turnId
        ? this.authFailure
        : null
    if (pending) {
      pending.shown = true
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
  /** `turnId` is the open ordinary turn; a command turn reads its failure from Claude's notice. */
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
        shown: false,
        // A 403 is also an access denial, so only a 401 earns sign-in guidance.
        row: this.failureRow(status === 401 ? 'notSignedIn' : 'providerResponseFailed', detail)
      }
    }
  }

  /** The failure an auth retry left for the result that ends its turn, read once; `shown` when
   *  Claude's own notice already wrote its row. */
  takeAuthFailure(turnId: string | null): { row: ClaudeFailureRow; shown: boolean } | null {
    const failure = this.authFailure
    this.authFailure = null
    return turnId !== null && failure?.turnId === turnId ? failure : null
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
