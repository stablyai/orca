export type TerminalStreamInputFailure = {
  outcome: 'rejected' | 'unknown'
  reason: string
}

export const TERMINAL_INPUT_HISTORY_LIMIT = 256
export const TERMINAL_INPUT_HISTORY_FAILURE: TerminalStreamInputFailure = {
  outcome: 'unknown',
  reason: 'input_history_limit'
}

export function grantTerminalInputPermit<T>(permits: Set<T>, value: T): void {
  permits.delete(value)
  if (permits.size >= TERMINAL_INPUT_HISTORY_LIMIT) {
    permits.delete(permits.values().next().value!)
  }
  permits.add(value)
}
