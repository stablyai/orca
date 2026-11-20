import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { ClaudeJournalTranslatorDeps } from './claude-journal-translator-contract'

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAssistantFailures {
  private readonly shown = new BoundedMap<string, string | null>({ maxEntries: 128 })
  constructor(
    private readonly launch: Pick<
      ClaudeJournalTranslatorDeps,
      'account' | 'model' | 'stopsOnFlaggedRequest'
    > = {}
  ) {}

  assistant(message: Record<string, unknown>) {
    const row = this.notice(message)
    if (row) {
      this.shown.set(this.scopeKey(message), claudeText(message.user_message_uuid))
    } else if (message.type === 'user' || message.type === 'assistant') {
      this.shown.delete(this.scopeKey(message))
    }
    return row
  }

  /** With switching off, the refused reply that follows carries the row, so this notice writes none. */
  foldsNoFallbackNotice(message: Record<string, unknown>): boolean {
    return (
      message.type === 'system' &&
      message.subtype === 'model_refusal_no_fallback' &&
      this.launch.stopsOnFlaggedRequest?.() === true
    )
  }

  /** Classify without recording it as shown; a caller that keeps the row must write it. */
  notice(message: Record<string, unknown>) {
    const root = (message.parent_tool_use_id ?? null) === null
    const unavailable = message.error === 'model_not_found' && root
    const refused =
      root &&
      typeof message.error === 'string' &&
      claudeRecord(message.message)?.stop_reason === 'refusal' &&
      this.launch.stopsOnFlaggedRequest?.() === true
    if (
      message.type !== 'assistant' ||
      (!unavailable && !refused && message.error !== 'authentication_failed')
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
    if (refused) {
      return {
        kind: 'status' as const,
        tone: 'error' as const,
        ...agentSessionFailureWords(
          // The CLI's own words keep its request ID behind Details.
          agentSessionFailureFact('flaggedRequestNotSwitched', {
            detail: providerDiagnostic(text, 'log')
          }),
          { agentName: 'Claude', provider: 'claude', surface: 'row' }
        )
      }
    }
    return {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(
        agentSessionFailureFact(unavailable ? 'modelUnavailable' : 'notSignedIn', {
          account: this.launch.account?.(),
          detail: unavailable
            ? providerDiagnostic(this.launch.model?.() ?? 'this model', 'log')
            : providerDiagnostic(text, 'person')
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
