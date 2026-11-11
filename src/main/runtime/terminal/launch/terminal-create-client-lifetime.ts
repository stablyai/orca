export function assertTerminalCreateClientConnected(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}
