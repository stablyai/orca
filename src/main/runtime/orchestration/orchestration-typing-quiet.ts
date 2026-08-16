/** Quiet window after user keystrokes before idle orchestration may write this PTY (#14832). */
export const ORCHESTRATION_TYPING_QUIET_MS = 5_000

export function remainingOrchestrationTypingQuietMs(input: {
  lastUserInputAt: number | undefined
  now: number
  windowFocused: boolean
}): number {
  // Why: splits / editor focus leave the draft on this PTY; tab.activeLeafId is not the gate.
  if (!input.windowFocused || input.lastUserInputAt === undefined) {
    return 0
  }
  return Math.max(ORCHESTRATION_TYPING_QUIET_MS - (input.now - input.lastUserInputAt), 0)
}

export function shouldDeferOrchestrationTypingQuiet(input: {
  lastUserInputAt: number | undefined
  now: number
  windowFocused: boolean
}): boolean {
  return remainingOrchestrationTypingQuietMs(input) > 0
}
