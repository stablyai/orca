import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import { providerExitStatusText } from '../provider-process/provider-process-exit-status'
import { providerStderrForDisplay } from '../provider-process/provider-spawn-failure-report'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

// Claude Code's own startup refusal: as root it exits before initialize rather than skip permissions.
const CLAUDE_ROOT_FULL_ACCESS_REFUSAL = /--dangerously-skip-permissions cannot be used with root/
const CLAUDE_MISSING_CONVERSATION =
  /^No conversation found with session ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/im

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
  const refusalReason = CLAUDE_ROOT_FULL_ACCESS_REFUSAL.test(detail)
    ? 'fullAccessAsRoot'
    : CLAUDE_MISSING_CONVERSATION.test(detail)
      ? 'savedConversationMissing'
      : null
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
