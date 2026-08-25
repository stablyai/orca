let nextTerminalStreamId = 1

export function allocateTerminalSubscriptionStreamId(): number {
  return nextTerminalStreamId++
}
