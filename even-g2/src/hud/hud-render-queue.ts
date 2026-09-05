// Serialized, latest-wins render loop over a GlassesBridge (spec S5). The SDK forbids
// concurrent bridge calls, so only one create/rebuild/upgrade is ever in flight; anything
// submitted meanwhile coalesces into a single "pending" slot.
import type {
  GlassesBridge,
  HudPageBuild,
  HudTextUpgrade,
  StartupBuildResult
} from '../glasses/glasses-bridge'
import { planHudRender, type HudRenderPlan } from './hud-page-differ'
import { validateHudPage, validateHudTextUpgrade } from './hud-page-validator'

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
  // Sticky across coalescing: once set, the next actual render is forced to a full rebuild even
  // if a concurrent submit resets `previous` before the queue drains (spec S5 exit-dialog case).
  private forceRebuild = false

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

  /** Drops the remembered previous page so the next submit rebuilds from scratch, even though
   * content may be unchanged — for when firmware clears/replaces the canvas out of band (e.g.
   * the in-canvas exit dialog) and our diff memory no longer reflects what's on screen. */
  invalidate(): void {
    this.previous = null
    this.forceRebuild = true
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

  /** Client-side twin of the SDK's own validation (spec S5): never let a renderer bug reach
   * firmware. Logs and reports the violation via onRenderError instead of sending. */
  private validatePage(page: HudPageBuild): boolean {
    const violations = validateHudPage(page)
    if (violations.length > 0) {
      this.onRenderError(`HUD page validation failed: ${JSON.stringify(violations)}`)
      return false
    }
    return true
  }

  private validateUpgrade(update: HudTextUpgrade): boolean {
    const violations = validateHudTextUpgrade(update)
    if (violations.length > 0) {
      this.onRenderError(`HUD upgrade validation failed: ${JSON.stringify(violations)}`)
      return false
    }
    return true
  }

  private async runPlan(page: HudPageBuild): Promise<void> {
    // A pending invalidate() forces a rebuild even if `previous` was reset by a coalesced submit
    // in the meantime, so the firmware canvas is guaranteed to be repainted.
    const forced = this.forceRebuild
    this.forceRebuild = false
    const plan: HudRenderPlan = forced
      ? { kind: 'rebuild', page }
      : planHudRender(this.previous, page, this.spent)

    if (plan.kind === 'noop') {
      return
    }

    if (plan.kind === 'create') {
      if (!this.validatePage(plan.page)) {
        return
      }
      // Latch spends before awaiting the bridge call, whether or not the attempt succeeds or
      // even throws: retrying a failed/rejected startup blocks ~2.1s and is rejected by
      // firmware regardless (verified platform trap), so a rejection must still fall through
      // to the controlled rebuild path rather than leaving the one-shot API unspent.
      this.spent = true
      let result: StartupBuildResult | null = null
      try {
        result = await this.bridge.createStartUpPage(plan.page)
      } catch (err) {
        this.onRenderError(`createStartUpPage threw: ${String(err)}`)
      }
      if (result === 'success') {
        this.previous = plan.page
        return
      }
      await this.rebuildWithRetry(plan.page)
      return
    }

    if (plan.kind === 'rebuild') {
      if (!this.validatePage(plan.page)) {
        return
      }
      await this.rebuildWithRetry(plan.page)
      return
    }

    // upgrade
    let allOk = true
    for (const update of plan.updates) {
      if (!this.validateUpgrade(update)) {
        allOk = false
        continue
      }
      const ok = await this.bridge.upgradeText(update)
      if (!ok) {
        allOk = false
      }
    }
    if (allOk) {
      this.previous = page
    } else if (this.validatePage(page)) {
      // An upgrade call failing (or being rejected by validation) leaves content out of sync
      // with firmware; rebuild recovers, once the full page itself is confirmed valid.
      await this.rebuildWithRetry(page)
    }
  }
}
