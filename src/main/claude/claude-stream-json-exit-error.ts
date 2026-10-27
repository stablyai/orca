import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { providerStderrForDisplay } from '../provider-process/provider-spawn-failure-report'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type ClaudeExitStatus = { code: number | null; signal: NodeJS.Signals | null }

// Claude Code's own startup refusal: as root it exits before initialize rather than skip permissions.
const CLAUDE_ROOT_FULL_ACCESS_REFUSAL = /--dangerously-skip-permissions cannot be used with root/

export function claudeStreamJsonExitError(
  stderrTail: string,
  status: ClaudeExitStatus | null,
  cause?: Error
): Error {
  const detail = providerStderrForDisplay(stderrTail).trim()
  // Retain exit status and stderr through wrappers for refused-start diagnostics.
  const how =
    status?.signal !== null && status?.signal !== undefined
      ? ` (signal ${status.signal})`
      : status?.code !== null && status?.code !== undefined
        ? ` (code ${status.code})`
        : ''
  const message = `claude stream-json exited${how}${detail ? `: ${detail}` : ''}`
  const diagnostic = providerDiagnostic([how.trim(), detail].filter(Boolean).join('\n'), 'log')
  // The typed refusal replaces this error in failure facts, so it carries the diagnostic too.
  const refusal = CLAUDE_ROOT_FULL_ACCESS_REFUSAL.test(detail)
    ? withProviderDiagnostic(
        Object.assign(
          new AgentSessionAcquisitionRefusal(message, 'fullAccessAsRoot'),
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
