import { providerDiagnostic, type ProviderDiagnostic } from '../../shared/agent-session-failure'

/** The ZCode app-server answered the call and refused it, rather than timing out or exiting. */
export class ZcodeAppServerRequestError extends Error {
  /** ZCode's own `error.message`, kept apart from the Orca text around it. */
  readonly providerDiagnostic?: ProviderDiagnostic

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    providerMessage?: string
  ) {
    super(message)
    this.name = 'ZcodeAppServerRequestError'
    const diagnostic =
      providerMessage === undefined ? undefined : providerDiagnostic(providerMessage, 'person')
    if (diagnostic) {
      this.providerDiagnostic = diagnostic
    }
  }
}

export function isZcodeAppServerRequestError(error: unknown): error is ZcodeAppServerRequestError {
  return error instanceof Error && error.name === 'ZcodeAppServerRequestError'
}

/** The busy code `session/send` returns while a turn is already running; the chat offers Stop. */
export const ZCODE_SESSION_BUSY_CODE = -32010
