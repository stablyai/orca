// Serializes composed native-chat write sequences (clear/paste/settle/submit,
// paced answer keystrokes) per HOST terminal. Two concurrent sequences into one
// PTY interleave their bytes; a second sender must be rejected up front, not
// woven in. Module scope for the same reason as the stale-input marker: the
// terminal outlives any one screen, and independent hooks share the same PTY.
const writeInFlightTerminals = new Set<string>()

/** Claim the terminal for one composed write sequence. False = another
 *  sequence is mid-flight; the caller must reject its send. */
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

/** Test-only: module scope outlives a single test's hooks. */
export function resetMobileNativeChatTerminalWritesForTests(): void {
  writeInFlightTerminals.clear()
}
