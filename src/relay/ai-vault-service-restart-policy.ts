const RELAY_AI_VAULT_FAULT_WINDOW_MS = 60_000
const RELAY_AI_VAULT_RESTART_DELAYS_MS = [250, 1_000, 5_000] as const

export class RelayAiVaultRestartPolicy {
  private faults: number[] = []
  private circuitUntil = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly now: () => number = Date.now) {}

  get restartScheduled(): boolean {
    return this.timer !== null
  }

  /** A forced refresh is a deliberate user action, so it reopens the circuit. */
  startError(forceStart: boolean): Error | null {
    if (forceStart) {
      this.circuitUntil = 0
      return null
    }
    return this.now() < this.circuitUntil
      ? new Error('Relay AI Vault service restart circuit is open.')
      : null
  }

  recordFault(): void {
    const now = this.now()
    this.faults = [
      ...this.faults.filter((time) => now - time < RELAY_AI_VAULT_FAULT_WINDOW_MS),
      now
    ]
    if (this.faults.length >= 3) {
      this.circuitUntil = now + RELAY_AI_VAULT_FAULT_WINDOW_MS
    }
  }

  scheduleRestart(restart: () => void): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    const delay = RELAY_AI_VAULT_RESTART_DELAYS_MS[Math.min(this.faults.length - 1, 2)]
    this.timer = setTimeout(() => {
      this.timer = null
      restart()
    }, delay)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
