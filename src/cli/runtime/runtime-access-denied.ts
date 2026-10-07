import { RuntimeClientError } from './types'
import { isProcessRunning } from './runtime-pid-liveness'

// Why: the errno decides the classification; CODEX_SANDBOX only picks the wording.
export function runtimeAccessDeniedError(
  socketError: Error,
  pid: number
): RuntimeClientError | null {
  const systemCode = 'code' in socketError ? socketError.code : undefined
  // Why: a sandbox still sees ESRCH, so a dead Orca's leftover socket gets not-running advice.
  if ((systemCode !== 'EPERM' && systemCode !== 'EACCES') || !isProcessRunning(pid)) {
    return null
  }
  const codexSandbox = Boolean(process.env.CODEX_SANDBOX)
  const message = codexSandbox
    ? `The Codex sandbox blocked this command from connecting to Orca (${systemCode}). Orca may be running normally.`
    : `Permission denied connecting to Orca (${systemCode}). Orca may be running normally; this command's sandbox or OS permissions block the connection.`
  const retryStep = codexSandbox
    ? 'Re-run this command with escalated permissions, outside the Codex sandbox.'
    : 'Re-run this command outside its sandbox, or as a user allowed to reach the Orca runtime.'
  return new RuntimeClientError('runtime_access_denied', message, {
    systemCode,
    nextSteps: [
      retryStep,
      "Do not restart Orca or run 'orca open'; a restart cannot grant this command access."
    ]
  })
}
