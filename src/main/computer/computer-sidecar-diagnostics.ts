/** Forward warnings over IPC because the sidecar's piped stdout/stderr are unread. */
export type ComputerSidecarDiagnostic = {
  kind: 'computer-sidecar-diagnostic'
  message: string
}

const DIAGNOSTIC_KIND = 'computer-sidecar-diagnostic'

export function isComputerSidecarDiagnostic(
  message: unknown
): message is ComputerSidecarDiagnostic {
  if (!message || typeof message !== 'object') {
    return false
  }
  const record = message as Record<string, unknown>
  return record.kind === DIAGNOSTIC_KIND && typeof record.message === 'string'
}

export function reportComputerDiagnostic(message: string): void {
  if (process.send) {
    process.send({ kind: DIAGNOSTIC_KIND, message } satisfies ComputerSidecarDiagnostic)
    return
  }
  logComputerDiagnostic(message)
}

export function logComputerDiagnostic(message: string): void {
  console.warn(`[computer-use] ${message}`)
}
