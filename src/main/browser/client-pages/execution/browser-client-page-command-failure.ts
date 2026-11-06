import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserExpectedUrlMismatch } from '../../../../shared/browser/client-hosting/browser-expected-url'

export class BrowserClientPageCommandError extends Error {
  readonly expectedUrlMismatch?: BrowserExpectedUrlMismatch

  constructor(
    message: string,
    options?: ErrorOptions & { expectedUrlMismatch?: BrowserExpectedUrlMismatch }
  ) {
    super(message, options)
    this.expectedUrlMismatch = options?.expectedUrlMismatch
  }
}

function browserClientPageCommandFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof BrowserClientPageCommandError) {
    return error.message
  }
  return signal.aborted
    ? 'browser_client_page_command_aborted'
    : 'browser_client_page_command_failed'
}

export function browserClientPageCommandFailure(
  error: unknown,
  signal: AbortSignal
): BrowserClientHostCommandResult {
  const mismatch =
    error instanceof BrowserClientPageCommandError ? error.expectedUrlMismatch : undefined
  return {
    status: 'failed',
    errorCode: browserClientPageCommandFailureCode(error, signal),
    ...(mismatch ? { expectedUrlMismatch: mismatch } : {})
  }
}

export function isBrowserClientPageCleanupFailure(error: unknown): boolean {
  return (
    error instanceof BrowserClientPageCommandError &&
    error.message === 'browser_client_page_cleanup_failed'
  )
}
