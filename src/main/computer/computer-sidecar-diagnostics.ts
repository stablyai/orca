/**
 * Warnings from the computer-use provider, routed to somewhere a human sees.
 *
 * Why not `console.warn`: the provider runs inside the forked sidecar, which
 * `sidecar-client.ts` starts with piped stdio that nothing ever reads. Anything
 * written there is discarded — including the only signal that a machine has
 * fallen back to `-ExecutionPolicy Bypass`, a state that persists for the
 * session. The sidecar has an IPC channel already, so the warning takes it.
 */
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

/** The main-process end: how a sidecar's forwarded diagnostic is printed. */
export function logComputerDiagnostic(message: string): void {
  console.warn(`[computer-use] ${message}`)
}
