export function requestsTerminalApplicationReceipts(method: string, params: unknown): boolean {
  return (
    method === 'terminal.subscribe' &&
    params !== null &&
    typeof params === 'object' &&
    'capabilities' in params &&
    params.capabilities !== null &&
    typeof params.capabilities === 'object' &&
    'ackOutput' in params.capabilities &&
    params.capabilities.ackOutput === 1
  )
}
