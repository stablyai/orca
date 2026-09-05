let nextTerminalStreamId = 1

export function allocateTerminalSubscriptionStreamId(): number {
  if (nextTerminalStreamId > 0xffffffff) {
    throw new Error('terminal_stream_ids_exhausted')
  }
  return nextTerminalStreamId++
}
