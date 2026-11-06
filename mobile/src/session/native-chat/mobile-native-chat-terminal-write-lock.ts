// Reject overlapping write sequences per host terminal to prevent interleaved bytes; module scope survives screens sharing the PTY.
const writeInFlightTerminals = new Set<string>()

export function acquireMobileNativeChatTerminalWrite(terminal: string): boolean {
  if (writeInFlightTerminals.has(terminal)) {
    return false
  }
  writeInFlightTerminals.add(terminal)
  return true
}

export function releaseMobileNativeChatTerminalWrite(terminal: string): void {
  writeInFlightTerminals.delete(terminal)
}

export function resetMobileNativeChatTerminalWritesForTests(): void {
  writeInFlightTerminals.clear()
}
