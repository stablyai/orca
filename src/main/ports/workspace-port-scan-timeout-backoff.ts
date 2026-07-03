const INITIAL_TIMEOUT_BACKOFF_MS = 60_000
const MAX_TIMEOUT_BACKOFF_MS = 5 * 60_000

type TimeoutBackoffState = {
  consecutiveTimeouts: number
  cooldownUntil: number
}

export type WorkspacePortScanTimeoutBackoffSnapshot = {
  isCoolingDown: boolean
  cooldownUntil: number
  remainingMs: number
  consecutiveTimeouts: number
}

export class WorkspacePortScanTimeoutBackoff {
  private state: TimeoutBackoffState = {
    consecutiveTimeouts: 0,
    cooldownUntil: 0
  }

  constructor(private readonly now: () => number = () => Date.now()) {}

  snapshot(): WorkspacePortScanTimeoutBackoffSnapshot {
    const now = this.now()
    return {
      isCoolingDown: this.state.cooldownUntil > now,
      cooldownUntil: this.state.cooldownUntil,
      remainingMs: Math.max(0, this.state.cooldownUntil - now),
      consecutiveTimeouts: this.state.consecutiveTimeouts
    }
  }

  recordTimeout(): WorkspacePortScanTimeoutBackoffSnapshot {
    const consecutiveTimeouts = this.state.consecutiveTimeouts + 1
    const delayMs = Math.min(
      MAX_TIMEOUT_BACKOFF_MS,
      INITIAL_TIMEOUT_BACKOFF_MS * 2 ** (consecutiveTimeouts - 1)
    )
    this.state = {
      consecutiveTimeouts,
      cooldownUntil: this.now() + delayMs
    }
    return this.snapshot()
  }

  recordSuccess(): void {
    this.reset()
  }

  reset(): void {
    this.state = {
      consecutiveTimeouts: 0,
      cooldownUntil: 0
    }
  }
}
