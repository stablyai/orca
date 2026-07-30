import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

// Why: match AGENT_AWAKE_STATUS_STALE_AFTER_MS so abandoned power assertions cannot linger forever.
export const BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS = 2 * 60 * 60 * 1000

type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type PlatformAwakeAssertion = {
  start: (reason: string) => void
  stop: (reason: string) => void
  dispose: () => void
}

type PowerMonitorEventSource = {
  on: (event: 'resume', listener: () => void) => void
  off: (event: 'resume', listener: () => void) => void
}

type Logger = Pick<Console, 'debug' | 'warn'>

type BrowserScreencastAwakeServiceOptions = {
  blocker?: PowerSaveBlocker
  getLiveTokens?: () => Iterable<string>
  linuxAssertion?: PlatformAwakeAssertion
  logger?: Logger
  macosAssertion?: PlatformAwakeAssertion
  now?: () => number
  powerMonitor?: PowerMonitorEventSource | null
  staleAfterMs?: number
}

type ElectronPowerApis = {
  powerMonitor: PowerMonitorEventSource
  powerSaveBlocker: PowerSaveBlocker
}

// Why: lazy-resolve Electron so incomplete `vi.mock('electron')` fixtures still import this module.
function loadElectronPowerApis(): ElectronPowerApis {
  return require('electron') as ElectronPowerApis
}

/** Keeps display/compositor awake while browser.screencast streams need CDP frames. */
export class BrowserScreencastAwakeService {
  private readonly tokens = new Map<string, number>()
  private blockerId: number | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private getLiveTokens: (() => Iterable<string>) | null
  private readonly blocker: PowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macosAssertion: PlatformAwakeAssertion
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: BrowserScreencastAwakeServiceOptions = {}) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS
    this.getLiveTokens = options.getLiveTokens ?? null
    const electronApis =
      options.blocker !== undefined && options.powerMonitor !== undefined
        ? null
        : loadElectronPowerApis()
    this.blocker = options.blocker ?? electronApis!.powerSaveBlocker
    // Windows lid close is intentionally not modeled as an assertion here:
    // keeping it awake requires mutating the user's global power plan.
    this.linuxAssertion =
      options.linuxAssertion ??
      new LinuxLidSleepAssertion({
        logger: this.logger,
        now: this.now,
        onUnexpectedFailure: (reason) => this.refresh(reason)
      })
    this.macosAssertion =
      options.macosAssertion ??
      new MacosSystemSleepAssertion({
        logger: this.logger,
        now: this.now,
        onUnexpectedFailure: (reason) => this.refresh(reason)
      })
    const resumeSource =
      options.powerMonitor !== undefined ? options.powerMonitor : electronApis!.powerMonitor
    if (resumeSource) {
      const onResume = () => this.refresh('power-resume')
      resumeSource.on('resume', onResume)
      this.unsubscribeResume = () => resumeSource.off('resume', onResume)
    } else {
      this.unsubscribeResume = null
    }
  }

  // Why: RuntimeBrowserCommands owns live pages; sync drops leaks and renews long sessions.
  setLiveTokenSource(getLiveTokens: (() => Iterable<string>) | null): void {
    this.getLiveTokens = getLiveTokens
    this.refresh('live-token-source-change')
  }

  acquire(token: string): void {
    if (!token) {
      return
    }
    this.tokens.set(token, this.now())
    this.refresh('screencast-acquire')
  }

  release(token: string): void {
    if (!token || !this.tokens.delete(token)) {
      return
    }
    this.refresh('screencast-release')
  }

  getActiveCount(): number {
    return this.getEligibleTokenCount(this.now())
  }

  dispose(): void {
    this.clearStaleTimer()
    this.unsubscribeResume?.()
    this.getLiveTokens = null
    this.tokens.clear()
    this.stopBlocker('dispose')
    this.macosAssertion.dispose()
    this.linuxAssertion.dispose()
  }

  private refresh(reason: string): void {
    this.reconcileWithLiveSource()
    this.scheduleStaleTimer()
    const activeCount = this.getEligibleTokenCount(this.now())
    if (activeCount > 0) {
      this.startBlocker(reason, activeCount)
      this.runAssertion('start', this.macosAssertion, reason, 'macOS system sleep assertion')
      this.runAssertion('start', this.linuxAssertion, reason, 'Linux lid sleep assertion')
    } else {
      this.stopBlocker(reason, activeCount)
      this.runAssertion('stop', this.macosAssertion, reason, 'macOS system sleep assertion')
      this.runAssertion('stop', this.linuxAssertion, reason, 'Linux lid sleep assertion')
    }
  }

  private reconcileWithLiveSource(): void {
    if (!this.getLiveTokens) {
      return
    }
    const live = new Set<string>()
    for (const token of this.getLiveTokens()) {
      if (token) {
        live.add(token)
      }
    }
    for (const token of this.tokens.keys()) {
      if (!live.has(token)) {
        this.tokens.delete(token)
      }
    }
    const now = this.now()
    for (const token of live) {
      this.tokens.set(token, now)
    }
  }

  private getEligibleTokenCount(now: number): number {
    let count = 0
    for (const seenAt of this.tokens.values()) {
      if (this.isWakeEligible(seenAt, now)) {
        count += 1
      }
    }
    return count
  }

  private isWakeEligible(seenAt: number, now: number): boolean {
    return Number.isFinite(seenAt) && now - seenAt <= this.staleAfterMs
  }

  private scheduleStaleTimer(): void {
    this.clearStaleTimer()
    const now = this.now()
    let earliestExpiry: number | null = null
    for (const seenAt of this.tokens.values()) {
      if (!Number.isFinite(seenAt)) {
        continue
      }
      const expiry = seenAt + this.staleAfterMs
      if (expiry <= now) {
        continue
      }
      earliestExpiry = earliestExpiry === null ? expiry : Math.min(earliestExpiry, expiry)
    }
    // Why: with a live-token source, renewals keep timestamps fresh; still poll so a
    // leaked token without a matching live page is pruned even when no expiry is due.
    if (earliestExpiry === null && !(this.getLiveTokens && this.tokens.size > 0)) {
      return
    }
    const delay = earliestExpiry === null ? this.staleAfterMs : Math.max(0, earliestExpiry - now)
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null
      this.pruneExpiredTokens()
      this.refresh('stale-expiry')
    }, delay)
    if (typeof this.staleTimer.unref === 'function') {
      this.staleTimer.unref()
    }
  }

  private pruneExpiredTokens(): void {
    const now = this.now()
    for (const [token, seenAt] of this.tokens) {
      if (!this.isWakeEligible(seenAt, now)) {
        this.tokens.delete(token)
      }
    }
  }

  private clearStaleTimer(): void {
    if (!this.staleTimer) {
      return
    }
    clearTimeout(this.staleTimer)
    this.staleTimer = null
  }

  private startBlocker(reason: string, activeCount: number): void {
    if (this.blockerId !== null) {
      if (this.reconcileBlocker('start-reconcile')) {
        return
      }
    }
    try {
      const id = this.blocker.start('prevent-display-sleep')
      this.blockerId = id
      this.reconcileBlocker('post-start')
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to start blocker', {
        reason,
        activeCount,
        error: err
      })
    }
  }

  private runAssertion(
    action: 'start' | 'stop',
    assertion: PlatformAwakeAssertion,
    reason: string,
    label: string
  ): void {
    try {
      assertion[action](reason)
    } catch (err) {
      this.logger.warn(`[browser-screencast-awake] failed to ${action} ${label}`, {
        reason,
        error: err
      })
    }
  }

  private stopBlocker(reason: string, activeCount = 0): void {
    if (this.blockerId === null) {
      return
    }
    const id = this.blockerId
    // Why: clear before stop so a later flaky isStarted() cannot strand a stale id.
    this.blockerId = null
    try {
      this.blocker.stop(id)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to stop blocker', {
        reason,
        activeCount,
        blockerId: id,
        error: err
      })
    }
  }

  private reconcileBlocker(reason: string): boolean {
    if (this.blockerId === null) {
      return false
    }
    const id = this.blockerId
    try {
      const isStarted = this.blocker.isStarted(id)
      if (!isStarted) {
        this.blockerId = null
      }
      return isStarted
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error: err
      })
      return true
    }
  }
}

let sharedBrowserScreencastAwakeService: BrowserScreencastAwakeService | null = null

export function getBrowserScreencastAwakeService(): BrowserScreencastAwakeService {
  sharedBrowserScreencastAwakeService ??= new BrowserScreencastAwakeService()
  return sharedBrowserScreencastAwakeService
}

export function disposeBrowserScreencastAwakeService(): void {
  sharedBrowserScreencastAwakeService?.dispose()
  sharedBrowserScreencastAwakeService = null
}
