import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import type { ProviderProcessExit } from '../../provider-process/managed-provider-process'
import { providerExitStatusText } from '../../provider-process/provider-process-exit-status'
import { providerStderrForDisplay } from '../../provider-process/provider-spawn-failure-report'
import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'

// Claude Code's own startup refusal: as root it exits before initialize rather than skip permissions.
const CLAUDE_ROOT_FULL_ACCESS_REFUSAL = /--dangerously-skip-permissions cannot be used with root/
const CLAUDE_MISSING_CONVERSATION =
  /^No conversation found with session ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/im

/** Claude Code's typed startup refusals, from its stderr or a startup result's `errors`. */
function claudeStartupRefusalReason(detail: string) {
  return CLAUDE_ROOT_FULL_ACCESS_REFUSAL.test(detail)
    ? 'fullAccessAsRoot'
    : CLAUDE_MISSING_CONVERSATION.test(detail)
      ? 'savedConversationMissing'
      : null
}

/** A startup failure Claude reported as a result: it proves no exit, so only a typed refusal is final. */
export function claudeStartupResultError(message: Record<string, unknown>): Error {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === 'string').join('\n')
    : ''
  const diagnostic = providerDiagnostic(
    errors.trim() || (typeof message.result === 'string' ? message.result : ''),
    'log'
  )
  const text = `claude reported a startup failure${diagnostic ? `: ${diagnostic.text}` : ''}`
  const reason = claudeStartupRefusalReason(errors)
  return withProviderDiagnostic(
    reason
      ? new AgentSessionAcquisitionRefusal(text, reason)
      : new ClaudeControlRequestError('startup', text),
    diagnostic
  )
}

export function claudeStreamJsonExitError(
  stderrTail: string,
  status: ProviderProcessExit | null,
  cause?: Error
): Error {
  const detail = providerStderrForDisplay(stderrTail).trim()
  // Retain exit status and stderr through wrappers for refused-start diagnostics.
  const how = providerExitStatusText(status)
  const message = `claude stream-json exited${how ? ` ${how}` : ''}${detail ? `: ${detail}` : ''}`
  const diagnostic = providerDiagnostic([how, detail].filter(Boolean).join('\n'), 'log')
  // The typed refusal replaces this error in failure facts, so it carries the diagnostic too.
  const refusalReason = claudeStartupRefusalReason(detail)
  const refusal = refusalReason
    ? withProviderDiagnostic(
        Object.assign(
          new AgentSessionAcquisitionRefusal(message, refusalReason),
          cause ? { cause } : {}
        ),
        diagnostic
      )
    : undefined
  const inner = refusal ?? cause
  return withProviderDiagnostic(
    inner ? new Error(message, { cause: inner }) : new Error(message),
    diagnostic
  )
}
