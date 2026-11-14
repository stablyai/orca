import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic,
  providerDiagnosticOf,
  withProviderDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { redactString, redactValue } from '../../../observability/redactor'
import { providerStderrForDisplay } from '../../../provider-process/provider-spawn-failure-report'
import type { AcpDialect } from '../../acp-dialects/acp-dialect'
import type { AcpStructuredConnection } from '../../process/acp-structured-connection'
import { AcpAgentError, acpErrorDataWords } from '../../transport/acp-errors'
import { acpAuthenticationRequired, acpPromptErrorDetail } from '../../turns/acp-prompt-failure'

/** Keep the rejection's type and retry meaning; diagnostics belong to the existing Details. */
export function withAcpStartupDiagnostic(
  error: unknown,
  connection: AcpStructuredConnection,
  dialect: AcpDialect
): void {
  if (
    !(error instanceof AcpAgentError) ||
    acpAuthenticationRequired(dialect, error) ||
    providerDiagnosticOf(error)
  ) {
    return
  }
  let words = acpPromptErrorDetail(dialect, error)
  if (error.data != null && acpErrorDataWords(error.data) === undefined) {
    try {
      words = dialect.promptErrorDetail?.(error) ?? JSON.stringify(redactValue(error.data)) ?? words
    } catch {
      // Diagnostic formatting must never replace the agent's rejection.
    }
  }
  const rpc = redactString(words).trim()
  const stderr = redactString(providerStderrForDisplay(connection.stderrTail())).trim()
  const limit = MAX_PROVIDER_DIAGNOSTIC_CHARS
  const reply = rpc.slice(0, stderr ? Math.floor(limit / 2) : limit)
  const tail = stderr.slice(-(limit - (reply ? reply.length + 1 : 0)))
  withProviderDiagnostic(error, providerDiagnostic([reply, tail].filter(Boolean).join('\n'), 'log'))
}
