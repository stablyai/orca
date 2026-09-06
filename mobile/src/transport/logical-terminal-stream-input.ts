import type { RpcClient } from './rpc-client'
import type { TerminalStreamInputFailure } from './terminal-stream-input-failure'
import {
  TERMINAL_INPUT_HISTORY_LIMIT,
  TERMINAL_INPUT_HISTORY_FAILURE,
  grantTerminalInputPermit
} from './terminal-stream-input-failure'

type InputAttempt = {
  generation: number
  pending: number
  failure: TerminalStreamInputFailure | null
}
type InputContext = { generation: number; session: RpcClient; available: boolean }
const interrupted: TerminalStreamInputFailure = {
  outcome: 'unknown',
  reason: 'connection_interrupted'
}

export class LogicalTerminalStreamInput {
  private readonly attempts = new Map<string, InputAttempt>()
  private overflow = false
  private overflowGeneration: number | null = null
  private readonly permits = new Set<string>()
  constructor(private readonly context: () => InputContext) {}

  supports = (terminal: string): boolean => {
    const { session } = this.context()
    return (
      this.overflow ||
      this.attempts.has(terminal) ||
      (session.supportsTerminalStreamInput?.(terminal) ?? false)
    )
  }

  fence = (): void => {
    this.overflow = true
    this.permits.clear()
    for (const attempt of this.attempts.values()) {
      attempt.failure ??= TERMINAL_INPUT_HISTORY_FAILURE
    }
    this.attempts.clear()
    this.overflowGeneration = null
    this.syncOverflow()
  }

  private syncOverflow(): void {
    const current = this.context()
    if (this.overflow && this.overflowGeneration !== current.generation) {
      this.overflowGeneration = current.generation
      this.permits.clear()
      current.session.fenceTerminalStreamInput?.()
    }
  }

  failure = (terminal: string): TerminalStreamInputFailure | null => {
    this.syncOverflow()
    const current = this.context()
    const attempt = this.attempts.get(terminal)
    if (attempt && (!current.available || attempt.generation !== current.generation)) {
      attempt.failure ??= interrupted
    }
    return (
      attempt?.failure ??
      current.session.getTerminalStreamInputFailure?.(terminal) ??
      (this.overflow && !this.permits.has(terminal) ? TERMINAL_INPUT_HISTORY_FAILURE : null)
    )
  }

  recover = (terminal: string): boolean => {
    this.syncOverflow()
    const current = this.context()
    if (
      !current.available ||
      (this.overflow && !current.session.fenceTerminalStreamInput) ||
      !current.session.recoverTerminalStreamInput?.(terminal)
    ) {
      return false
    }
    this.attempts.delete(terminal)
    if (this.overflow) {
      grantTerminalInputPermit(this.permits, terminal)
    }
    return true
  }

  cancel = (terminal: string): void => {
    this.permits.delete(terminal)
    const attempt = this.attempts.get(terminal)
    if (attempt?.pending) {
      attempt.failure ??= { outcome: 'unknown', reason: 'cancelled' }
    }
    this.context().session.cancelTerminalStreamInput?.(terminal)
  }

  send = (terminal: string, text: string): Promise<boolean> | null => {
    const context = this.context()
    if (!context.available || this.failure(terminal)) {
      return Promise.resolve(false)
    }
    const previous = this.attempts.get(terminal)
    if (!previous && this.attempts.size >= TERMINAL_INPUT_HISTORY_LIMIT) {
      this.fence()
      return Promise.resolve(false)
    }
    const result = context.session.sendTerminalStreamInput?.(terminal, text) ?? null
    if (!result) {
      return previous ? Promise.resolve(false) : null
    }
    const attempt = previous ?? { generation: context.generation, pending: 0, failure: null }
    attempt.pending += 1
    this.attempts.set(terminal, attempt)
    return result.then(
      (accepted) => this.settle(terminal, attempt, accepted),
      () => this.settle(terminal, attempt, false)
    )
  }

  private settle(terminal: string, attempt: InputAttempt, accepted: boolean): boolean {
    const current = this.context()
    const valid =
      accepted && current.available && current.generation === attempt.generation && !attempt.failure
    attempt.pending -= 1
    if (!valid) {
      attempt.failure ??=
        current.generation === attempt.generation
          ? (current.session.getTerminalStreamInputFailure?.(terminal) ?? interrupted)
          : interrupted
    }
    if (this.attempts.get(terminal) === attempt) {
      if (attempt.failure) {
        this.permits.delete(terminal)
      }
      if (attempt.pending === 0 && (!attempt.failure || this.overflow)) {
        this.attempts.delete(terminal)
      }
    }
    return valid
  }
}
