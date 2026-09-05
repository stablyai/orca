// Serialized, latest-wins render loop over a GlassesBridge (spec S5). The SDK forbids
// concurrent bridge calls, so only one create/rebuild/upgrade is ever in flight; anything
// submitted meanwhile coalesces into a single "pending" slot.
import type { GlassesBridge, HudPageBuild } from '../glasses/glasses-bridge'
import { planHudRender } from './hud-page-differ'

const REBUILD_RETRY_DELAY_MS = 500

export type HudRenderQueueOptions = {
  /** Injection point for deterministic tests; defaults to the real global setTimeout. */
  setTimeout?: (callback: () => void, ms: number) => unknown
  onRenderError?: (message: string) => void
}

export class HudRenderQueue {
  private readonly bridge: GlassesBridge
  private readonly scheduleTimeout: (callback: () => void, ms: number) => unknown
  private readonly onRenderError: (message: string) => void

  private previous: HudPageBuild | null = null
  private busy = false
  private pending: HudPageBuild | null = null
  private spent = false

  constructor(bridge: GlassesBridge, opts?: HudRenderQueueOptions) {
    this.bridge = bridge
    this.scheduleTimeout = opts?.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    this.onRenderError = opts?.onRenderError ?? (() => {})
  }

  get startupSpent(): boolean {
    return this.spent
  }

  submit(page: HudPageBuild): void {
    this.pending = page
    if (!this.busy) {
      this.drain()
    }
  }

  private drain(): void {
    const page = this.pending
    if (page === null) {
      return
    }
    this.pending = null
    this.busy = true
    void this.runPlan(page).finally(() => {
      this.busy = false
      if (this.pending !== null) {
        this.drain()
      }
    })
  }

  private scheduleDelay(ms: number): Promise<void> {
    return new Promise((resolve) => this.scheduleTimeout(resolve, ms))
  }

  /** Rebuild once; on failure wait and retry exactly once more before surfacing an error. */
  private async rebuildWithRetry(page: HudPageBuild): Promise<void> {
    const ok = await this.bridge.rebuildPage(page)
    if (ok) {
      this.previous = page
      return
    }
    await this.scheduleDelay(REBUILD_RETRY_DELAY_MS)
    const retryOk = await this.bridge.rebuildPage(page)
    if (retryOk) {
      this.previous = page
    } else {
      this.onRenderError('rebuild failed after retry')
    }
  }

  private async runPlan(page: HudPageBuild): Promise<void> {
    const plan = planHudRender(this.previous, page, this.spent)

    if (plan.kind === 'noop') {
      return
    }

    if (plan.kind === 'create') {
      const result = await this.bridge.createStartUpPage(plan.page)
      // Latch spends whether or not the attempt succeeded: retrying a failed startup
      // blocks ~2.1s and is rejected by firmware (verified platform trap).
      this.spent = true
      if (result === 'success') {
        this.previous = plan.page
        return
      }
      await this.rebuildWithRetry(plan.page)
      return
    }

    if (plan.kind === 'rebuild') {
      await this.rebuildWithRetry(plan.page)
      return
    }

    // upgrade
    let allOk = true
    for (const update of plan.updates) {
      const ok = await this.bridge.upgradeText(update)
      if (!ok) {
        allOk = false
      }
    }
    if (allOk) {
      this.previous = page
    } else {
      // An upgrade call failing leaves content out of sync with firmware; rebuild recovers.
      await this.rebuildWithRetry(page)
    }
  }
}
