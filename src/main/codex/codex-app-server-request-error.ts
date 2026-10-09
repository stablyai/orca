import { providerDiagnostic, type ProviderDiagnostic } from '../../shared/agent-session-failure'
import { isProviderDiagnosticPersonText } from '../../shared/provider-diagnostic-person-text'

const JSON_RPC_PROTOCOL_ERROR_CODES = new Set([-32700, -32600, -32601, -32602, -32603])

/** Codex answered the call and refused it, rather than timing out or exiting. */
export class CodexAppServerRequestError extends Error {
  /** Codex's own `error.message`, kept apart from the Orca text around it. */
  readonly providerDiagnostic?: ProviderDiagnostic

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    providerMessage?: string
  ) {
    super(message)
    this.name = 'CodexAppServerRequestError'
    const diagnostic =
      providerMessage === undefined
        ? undefined
        : providerDiagnostic(
            providerMessage,
            !JSON_RPC_PROTOCOL_ERROR_CODES.has(code ?? 0) &&
              isProviderDiagnosticPersonText(providerMessage)
              ? 'person'
              : 'log'
          )
    if (diagnostic) {
      this.providerDiagnostic = diagnostic
    }
  }
}

export function isCodexAppServerRequestError(error: unknown): error is CodexAppServerRequestError {
  return error instanceof Error && error.name === 'CodexAppServerRequestError'
}
