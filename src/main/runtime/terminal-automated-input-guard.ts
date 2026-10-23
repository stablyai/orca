export type TerminalAutomatedInputGuard = {
  assertCurrent: () => void
  recordOwnWrite: () => void
  recordObservation: (sequence: number) => void
}
