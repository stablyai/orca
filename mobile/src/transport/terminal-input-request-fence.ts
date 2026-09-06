import type { TerminalStreamInputFailure } from './terminal-stream-input-failure'

export function assertTerminalInputRequestAllowed(
  method: string,
  params: unknown,
  failure: (terminal: string) => TerminalStreamInputFailure | null
): void {
  if (method !== 'terminal.send' || !params || typeof params !== 'object') {
    return
  }
  const terminal = (params as { terminal?: unknown }).terminal
  if (typeof terminal === 'string' && failure(terminal)) {
    throw new Error(
      'Terminal input stopped; explicitly recover a fresh subscription before sending more input.'
    )
  }
}
