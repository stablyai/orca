import type {
  RuntimeTerminalWaitCondition,
  RuntimeTerminalWait
} from '../../../../shared/runtime-terminal-contracts'

export type TerminalWaiter = {
  handle: string
  /** The terminal the handle named when the wait began; the wait follows it, not the handle. */
  ptyId: string
  condition: RuntimeTerminalWaitCondition
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
  /** Retires this waiter from the shared idle-poll sweep; null when not polling. */
  cancelIdlePoll: (() => void) | null
  abortCleanup: (() => void) | null
  /** Main-only launch-readiness wait: name-only titles require quiet output (TuiIdleEvaluationInput.launchReadiness). */
  launchReadiness?: boolean
  /** Main-only: a recognized agent mid-turn settles it, as mail delivery treats one (`settlesForMidTurnInput`). */
  acceptsMidTurnInput?: boolean
}
