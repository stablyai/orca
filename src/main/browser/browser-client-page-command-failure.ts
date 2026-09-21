export class BrowserClientPageCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export function browserClientPageCommandFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof BrowserClientPageCommandError) {
    return error.message
  }
  return signal.aborted
    ? 'browser_client_page_command_aborted'
    : 'browser_client_page_command_failed'
}

export function isBrowserClientPageCleanupFailure(error: unknown): boolean {
  return (
    error instanceof BrowserClientPageCommandError &&
    error.message === 'browser_client_page_cleanup_failed'
  )
}
