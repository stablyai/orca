import {
  providerDiagnostic,
  type ProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

/** Codex answered the call and refused it, rather than timing out or exiting. */
export class CodexAppServerRequestError extends Error {
  /** Codex's own `error.message`, kept apart from the Orca text around it. */
  readonly providerDiagnostic?: ProviderDiagnostic
  readonly data?: unknown

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    providerMessage?: string,
    data?: unknown
  ) {
    super(message)
    this.name = 'CodexAppServerRequestError'
    Object.defineProperty(this, 'data', { value: data, enumerable: false })
    const diagnostic =
      providerMessage === undefined ? undefined : providerDiagnostic(providerMessage, 'person')
    if (diagnostic) {
      this.providerDiagnostic = diagnostic
    }
  }
}

export function isCodexAppServerRequestError(error: unknown): error is CodexAppServerRequestError {
  return error instanceof Error && error.name === 'CodexAppServerRequestError'
}

/** Missing app-server subcommand or RPC method; only this class marks capability caches unsupported. */
export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerUnsupportedError'
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerTimeoutError'
  }
}

/** This Codex has no such RPC: method-not-found, or serde's unknown-variant refusal. */
export function isCodexMethodRefusal(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'CodexAppServerUnsupportedError') ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes('unknown variant'))
  )
}
