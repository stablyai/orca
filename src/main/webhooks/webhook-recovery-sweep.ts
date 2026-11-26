// The minute sweep that settles started runs, prunes the ledger and bounds call files. It runs only
// while something is left to recover, so a host without webhook work keeps no timer.
import { sweepWebhookCallFiles } from './webhook-call-file'
import { isSettledWebhookCall } from './webhook-call-outcomes'
import { WEBHOOK_LEDGER_RETENTION_MS, type WebhookHostLedger } from './webhook-host-ledger'

const SWEEP_MS = 60_000

export class WebhookRecoverySweep {
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  private started = false
  // Call files the last pass left, owned or still in their grace.
  private callFilesLeft = 0

  constructor(
    private readonly deps: {
      ledger: WebhookHostLedger
      settleRuns: () => void
      reconcileHooks: () => void
      botFolders: () => readonly string[]
    }
  ) {}

  /** One pass now, resolved once done. */
  start(): Promise<void> {
    this.started = true
    return this.sweep()
  }

  stop(): void {
    this.started = false
    this.arm()
  }

  /** Runs the timer while a call, intent, unconfirmed hook change or call file is left. */
  arm(): void {
    const { ledger } = this.deps
    const needed =
      this.started &&
      (this.callFilesLeft > 0 ||
        ledger.calls().length > 0 ||
        ledger.intents().length > 0 ||
        ledger.hooks().some((hook) => hook.change))
    if (needed && !this.timer) {
      this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
      this.timer.unref?.()
    } else if (!needed && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) {
      return
    }
    this.sweeping = true
    const { ledger } = this.deps
    try {
      this.deps.settleRuns()
      const now = Date.now()
      ledger.prune(now, isSettledWebhookCall)
      const owned = ledger.files()
      let left = 0
      for (const folder of this.deps.botFolders()) {
        left += await sweepWebhookCallFiles(folder, owned, now, WEBHOOK_LEDGER_RETENTION_MS)
      }
      this.callFilesLeft = left
      if (ledger.hooks().some((hook) => hook.change)) {
        this.deps.reconcileHooks()
      }
    } finally {
      this.sweeping = false
      this.arm()
    }
  }
}
