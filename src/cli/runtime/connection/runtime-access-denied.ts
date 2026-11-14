import { RuntimeClientError } from './types'

// Errno determines denial; CODEX_SANDBOX only selects wording.
export function runtimeAccessDeniedError(socketError: Error): RuntimeClientError | null {
  const systemCode = 'code' in socketError ? socketError.code : undefined
  if (systemCode !== 'EPERM' && systemCode !== 'EACCES') {
    return null
  }
  const codexSandbox = Boolean(process.env.CODEX_SANDBOX)
  const message = codexSandbox
    ? `The Codex sandbox blocked this command from connecting to Orca (${systemCode}). Orca may be running normally.`
    : `Permission denied connecting to Orca (${systemCode}). Orca may be running normally; this command's sandbox or OS permissions block the connection.`
  const retryStep = codexSandbox
    ? "Retry through Codex's existing escalation when the session permits it; otherwise run the same command from a terminal outside the sandbox."
    : 'Re-run this command outside its sandbox, or as a user allowed to reach the Orca runtime.'
  return new RuntimeClientError('runtime_access_denied', message, {
    systemCode,
    nextSteps: [
      retryStep,
      "Do not restart Orca or run 'orca open'; a restart cannot grant this command access."
    ]
  })
}
