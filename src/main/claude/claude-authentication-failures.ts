import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'

/** Associates the assistant's typed error with its duplicate result, never with error text. */
export class ClaudeAuthenticationFailures {
  private readonly shown = new BoundedMap<string, true>({ maxEntries: 128 })
  constructor(private readonly account?: () => AgentSessionAccountKind | undefined) {}

  assistant(message: Record<string, unknown>) {
    if (message.type !== 'assistant' || message.error !== 'authentication_failed') {
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
    const key = this.key(message)
    if (key) {
      this.shown.set(key, true)
    }
    return {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(
        agentSessionFailureFact('notSignedIn', {
          account: this.account?.(),
          detail: providerDiagnostic(text, 'person')
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }

  resultAlreadyShown(message: Record<string, unknown>): boolean {
    const key = this.key(message)
    if (!key || !this.shown.has(key)) {
      return false
    }
    this.shown.delete(key)
    return message.is_error === true
  }

  private key(message: Record<string, unknown>): string | null {
    const uuid = claudeText(message.user_message_uuid)
    return uuid
      ? JSON.stringify([message.session_id, message.parent_tool_use_id ?? null, uuid])
      : null
  }
}
