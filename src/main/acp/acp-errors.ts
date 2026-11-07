import type { AuthMethod } from './generated/acp-protocol.generated'
import { withProviderRequestTimeout } from '../provider-process/provider-request-timeout'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

/** The Orca request an agent rejection answered; never persisted. */
export type AcpAgentErrorRequest = { method: string; sessionId?: string }

/** A rejection received from the agent, distinct from local transport failures. */
export class AcpAgentError extends AcpRpcError {
  request?: AcpAgentErrorRequest

  constructor(code: number, message: string, data?: unknown) {
    super(code, message, data)
    this.name = 'AcpAgentError'
  }
}

export class AcpAuthRequiredError extends AcpAgentError {
  constructor(
    message: string,
    data?: unknown,
    readonly authMethods: AuthMethod[] = []
  ) {
    super(-32000, message, data)
    this.name = 'AcpAuthRequiredError'
  }
}

/** Orca's sign-in prompt message, distinct from an agent-authored error. */
export class AcpSignInPromptError extends AcpAuthRequiredError {}

/** Preserve prompt errors so Orca's diagnostic text is never attributed to the agent. */
export function acpAuthRequiredError(
  error: AcpAgentError,
  authMethods?: AuthMethod[]
): AcpAuthRequiredError {
  return error instanceof AcpSignInPromptError
    ? error
    : new AcpAuthRequiredError(error.message, error.data, authMethods)
}

/** Retains the raw answer in `data` and validation failures in `issues`. */
export class AcpInvalidResponseError extends AcpRpcError {
  constructor(
    message: string,
    raw: unknown,
    readonly issues?: unknown
  ) {
    super(-32603, message, raw)
    this.name = 'AcpInvalidResponseError'
  }
}

export class AcpFrameTooLargeError extends Error {
  constructor(
    readonly method: string | null,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `ACP${method ? ` ${method}` : ''} message exceeds ${maxBytes} byte limit (${observedBytes} bytes received)`
    )
    this.name = 'AcpFrameTooLargeError'
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(message = 'ACP connection closed') {
    super(message)
    this.name = 'AcpConnectionClosedError'
  }
}

/** The agent's process ended on its own and its output drained with the call still unanswered.
 *  Its stderr is the agent's own account, shown behind Details. */
export class AcpAgentExitedError extends AcpConnectionClosedError {
  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'AcpAgentExitedError'
    if (stderr) {
      withProviderDiagnostic(this, providerDiagnostic(stderr, 'person'))
    }
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    timeoutMs: number
  ) {
    super(`ACP request timed out: ${method}`)
    this.name = 'AcpRequestTimeoutError'
    withProviderRequestTimeout(this, { method, timeoutMs })
  }
}
