import {
  providerDiagnostic,
  type ProviderDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import { providerStderrForDisplay } from '../../provider-process/provider-spawn-failure-report'

/** The transport ended. Protocol failures are Orca refusing what zcode wrote, so not an exit. */
export class ZcodeAppServerExitError extends Error {
  constructor(
    message: string,
    readonly protocolFailure = false
  ) {
    super(message)
    this.name = 'ZcodeAppServerExitError'
  }
}

/** zcode answered the call and refused it, rather than timing out or exiting. */
export class ZcodeAppServerRequestError extends Error {
  /** zcode's own `error.message`, kept apart from the Orca text around it. */
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
    this.name = 'ZcodeAppServerRequestError'
    Object.defineProperty(this, 'data', { value: data, enumerable: false })
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

/** Missing app-server mode or RPC method; only this class marks capability probes unsupported. */
export class ZcodeAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerUnsupportedError'
  }
}

export class ZcodeAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerTimeoutError'
  }
}

export class ZcodeAppServerFrameSizeError extends Error {
  constructor(
    readonly method: string | null,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `zcode app-server${method ? ` ${method}` : ''} response exceeds ${maxBytes} byte limit (${observedBytes} bytes received)`
    )
    this.name = 'ZcodeAppServerFrameSizeError'
  }
}

const EXIT_DETAIL_MAX_CHARS = 400

export function buildZcodeAppServerExitError(
  stderrTail: string,
  cause?: Error,
  protocolFailure = false
): Error {
  const tail = providerStderrForDisplay(stderrTail).trim().slice(0, EXIT_DETAIL_MAX_CHARS)
  const diagnostic = providerDiagnostic(tail, 'log')
  const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
  const error = new ZcodeAppServerExitError(
    `zcode app-server connection ended${detail}`,
    protocolFailure
  )
  return cause ? error : withProviderDiagnostic(error, diagnostic)
}

/** The provider's own "method not found" shape, which marks an unsupported call. */
export function isZcodeMethodNotFoundError(error: unknown): boolean {
  return (
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === -32601
  )
}
