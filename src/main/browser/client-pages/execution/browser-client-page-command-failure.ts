import {
  truncateBrowserClientAutomationErrorMessage,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserExpectedUrlMismatch } from '../../../../shared/browser/client-hosting/browser-expected-url'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'

export class BrowserClientPageCommandError extends Error {
  readonly expectedUrlMismatch?: BrowserExpectedUrlMismatch
  /** The browser command's own message, so the host can show it with the code. */
  readonly detail?: string

  constructor(
    message: string,
    options?: ErrorOptions & { expectedUrlMismatch?: BrowserExpectedUrlMismatch; detail?: string }
  ) {
    super(message, options)
    this.expectedUrlMismatch = options?.expectedUrlMismatch
    this.detail = options?.detail
  }
}

function browserClientPageCommandFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof BrowserClientPageCommandError) {
    return error.message
  }
  if (signal.aborted) {
    return 'browser_client_page_command_aborted'
  }
  // The host's own refusal, e.g. an upload path it cannot read, goes back as the host sent it.
  return error instanceof RemoteRuntimeClientError
    ? error.code
    : 'browser_client_page_command_failed'
}

export function browserClientPageCommandFailure(
  error: unknown,
  signal: AbortSignal
): BrowserClientHostCommandResult {
  const mismatch =
    error instanceof BrowserClientPageCommandError ? error.expectedUrlMismatch : undefined
  const detail =
    error instanceof BrowserClientPageCommandError
      ? error.detail
      : error instanceof RemoteRuntimeClientError && !signal.aborted
        ? error.message
        : undefined
  const errorMessage = detail ? truncateBrowserClientAutomationErrorMessage(detail) : undefined
  return {
    status: 'failed',
    errorCode: browserClientPageCommandFailureCode(error, signal),
    ...(errorMessage ? { errorMessage } : {}),
    ...(mismatch ? { expectedUrlMismatch: mismatch } : {})
  }
}

export function isBrowserClientPageCleanupFailure(error: unknown): boolean {
  return (
    error instanceof BrowserClientPageCommandError &&
    error.message === 'browser_client_page_cleanup_failed'
  )
}
