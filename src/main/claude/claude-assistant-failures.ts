import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAssistantFailures {
  private readonly shown = new BoundedMap<string, string | null>({ maxEntries: 128 })
  constructor(
    private readonly account?: () => AgentSessionAccountKind | undefined,
    private readonly model?: () => string | undefined
  ) {}

  assistant(message: Record<string, unknown>) {
    const unavailable =
      message.error === 'model_not_found' && (message.parent_tool_use_id ?? null) === null
    if (
      message.type !== 'assistant' ||
      (!unavailable && message.error !== 'authentication_failed')
    ) {
      if (message.type === 'user' || message.type === 'assistant') {
        this.shown.delete(this.scopeKey(message))
      }
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
    this.shown.set(this.scopeKey(message), claudeText(message.user_message_uuid))
    return {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(
        agentSessionFailureFact(unavailable ? 'modelUnavailable' : 'notSignedIn', {
          account: this.account?.(),
          detail: unavailable
            ? providerDiagnostic(this.model?.() ?? 'this model', 'log')
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
