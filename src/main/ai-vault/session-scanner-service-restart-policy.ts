const AI_VAULT_SERVICE_FAULT_WINDOW_MS = 60_000
const AI_VAULT_SERVICE_RESTART_DELAYS_MS = [250, 1_000, 5_000] as const

export class AiVaultServiceRestartPolicy {
  private faults: number[] = []
  private circuitUntil = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly now: () => number = Date.now) {}

  get restartScheduled(): boolean {
    return this.timer !== null
  }

  clearCircuit(): void {
    this.circuitUntil = 0
    this.faults = []
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  startError(): Error | null {
    return this.now() < this.circuitUntil
      ? new Error('AI Vault service restart circuit is open.')
      : null
  }

  recordFault(restart: () => void): void {
    const now = this.now()
    this.faults = [
      ...this.faults.filter((time) => now - time < AI_VAULT_SERVICE_FAULT_WINDOW_MS),
      now
    ]
    if (this.faults.length >= 3) {
      this.circuitUntil = now + AI_VAULT_SERVICE_FAULT_WINDOW_MS
    }
    const delay = AI_VAULT_SERVICE_RESTART_DELAYS_MS[Math.min(this.faults.length - 1, 2)]
    // Replace pending timers so dispose() can still cancel every restart.
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        restart()
      },
      Math.max(delay, this.circuitUntil - now)
    )
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
