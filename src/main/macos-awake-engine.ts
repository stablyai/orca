import {
  DEFAULT_MACOS_AWAKE_ENGINE,
  normalizeMacosAwakeEngine,
  type AmphetamineUnavailableReason,
  type MacosAwakeEngine
} from '../shared/computer-awake-mode'
import { detectAmphetamineInstalled } from './macos-amphetamine-session'
import { MacosAmphetamineSessionObserver } from './macos-amphetamine-session-observer'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

type Logger = Pick<Console, 'debug' | 'warn'>

export type PlatformAwakeAssertion = {
  start: (reason: string) => void
  stop: (reason: string) => void
  dispose: () => void
}

export type AmphetamineSessionObserver = {
  start: (reason: string) => void
  stop: (reason: string) => void
  dispose: () => void
  isUnavailable: () => boolean
  getUnavailableReason: () => AmphetamineUnavailableReason | null
  clearUnavailable: () => void
  isActive: () => boolean
}

export type MacosAwakeEngineStatusFields = {
  macosEngine?: MacosAwakeEngine
  amphetamineInstalled?: boolean
  amphetamineUnavailableReason?: AmphetamineUnavailableReason
  amphetamineActive?: boolean
}

export type MacosAwakeEngineRouterOptions = {
  amphetamineObserver?: AmphetamineSessionObserver
  caffeinateAssertion?: PlatformAwakeAssertion
  detectAmphetamine?: (signal?: AbortSignal) => Promise<boolean | undefined>
  logger?: Logger
  now?: () => number
  /** Re-run the awake decision now, rather than waiting for the next status change. */
  onNeedsRefresh?: (reason: string) => void
  platform?: NodeJS.Platform
}

/** Owns caffeinate and routes the optional read-only Amphetamine observation. */
export class MacosAwakeEngineRouter {
  private readonly amphetamineObserver: AmphetamineSessionObserver
  private readonly caffeinateAssertion: PlatformAwakeAssertion
  private readonly detectAmphetamine: (signal?: AbortSignal) => Promise<boolean | undefined>
  private readonly logger: Logger
  private readonly onNeedsRefresh: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private engine: MacosAwakeEngine = DEFAULT_MACOS_AWAKE_ENGINE
  private amphetamineInstalled: boolean | undefined
  private disposed = false
  private implicitProbeAttempted = false
  private probeAbort: AbortController | null = null
  private probeAgain = false
  private probePromise: Promise<boolean | undefined> | null = null

  constructor(options: MacosAwakeEngineRouterOptions = {}) {
    this.logger = options.logger ?? console
    this.onNeedsRefresh = options.onNeedsRefresh ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.detectAmphetamine =
      options.detectAmphetamine ??
      ((signal) => detectAmphetamineInstalled(undefined, this.platform, signal))
    const now = options.now ?? Date.now
    this.caffeinateAssertion =
      options.caffeinateAssertion ??
      new MacosSystemSleepAssertion({
        logger: this.logger,
        now,
        onUnexpectedFailure: (reason) => this.onNeedsRefresh(reason)
      })
    this.amphetamineObserver =
      options.amphetamineObserver ??
      new MacosAmphetamineSessionObserver({
        logger: this.logger,
        now,
        onUnexpectedFailure: (reason) => this.requestRefresh(reason),
        onStateChanged: () => this.requestRefresh('amphetamine-state'),
        // The picker reads this verdict, and observation must stop until the
        // user explicitly retries after fixing installation or Automation.
        onUnavailable: (unavailableReason) => {
          if (this.disposed) {
            return
          }
          if (unavailableReason === 'not-installed') {
            this.amphetamineInstalled = false
          }
          this.requestRefresh('amphetamine-unavailable')
        }
      })
  }

  /** Returns true when the caller should refresh. */
  setEngine(engine: MacosAwakeEngine): boolean {
    if (this.disposed) {
      return false
    }
    const normalized = normalizeMacosAwakeEngine(engine)
    if (normalized === 'amphetamine') {
      // Re-picking Amphetamine is the user's retry gesture after fixing a
      // refused Automation grant, so it must clear the verdict even when the
      // engine is unchanged.
      this.amphetamineObserver.clearUnavailable()
      void this.probeInstalled()
    }
    if (this.engine === normalized) {
      return normalized === 'amphetamine'
    }
    this.engine = normalized
    return true
  }

  /** Probe once, lazily, the first time anything asks for status. */
  async probeInstalledIfUnknown(): Promise<boolean | undefined> {
    if (this.disposed || this.platform !== 'darwin') {
      return undefined
    }
    if (this.probePromise) {
      return this.probePromise
    }
    if (this.amphetamineInstalled !== undefined) {
      return this.amphetamineInstalled
    }
    if (this.implicitProbeAttempted) {
      return this.amphetamineInstalled
    }
    this.implicitProbeAttempted = true
    return this.probeInstalled()
  }

  /** Refresh the installed probe so the picker can disable Amphetamine before it is ever selected. */
  probeInstalled(): Promise<boolean | undefined> {
    if (this.platform !== 'darwin' || this.disposed) {
      return Promise.resolve(undefined)
    }
    this.implicitProbeAttempted = true
    if (this.probePromise) {
      // The refresh must sample after the older probe, not return its stale verdict.
      this.probeAgain = true
      return this.probePromise
    }
    this.probePromise = this.runInstalledProbeLoop()
    return this.probePromise
  }

  /** Retry availability without letting a stale renderer rewrite the current preference. */
  async retryUnavailable(): Promise<boolean | undefined> {
    const installed = await this.probeInstalled()
    if (
      installed === true &&
      !this.disposed &&
      this.engine === 'amphetamine' &&
      this.amphetamineObserver.getUnavailableReason() === 'automation-denied'
    ) {
      this.amphetamineObserver.clearUnavailable()
      this.requestRefresh('amphetamine-retry')
    }
    return installed
  }

  private async runInstalledProbeLoop(): Promise<boolean | undefined> {
    try {
      let installed = await this.runInstalledProbe()
      while (this.probeAgain && !this.disposed) {
        this.probeAgain = false
        installed = await this.runInstalledProbe()
      }
      return installed
    } finally {
      this.probeAgain = false
      this.probePromise = null
    }
  }

  private async runInstalledProbe(): Promise<boolean | undefined> {
    try {
      const abort = new AbortController()
      this.probeAbort = abort
      let installed: boolean | undefined
      try {
        installed = await this.detectAmphetamine(abort.signal)
      } finally {
        if (this.probeAbort === abort) {
          this.probeAbort = null
        }
      }
      if (this.disposed) {
        return undefined
      }
      if (installed === undefined) {
        return undefined
      }
      let shouldRefresh = false
      if (installed && this.amphetamineObserver.getUnavailableReason() === 'not-installed') {
        this.amphetamineObserver.clearUnavailable()
        shouldRefresh = true
      }
      if (this.amphetamineInstalled !== installed) {
        this.amphetamineInstalled = installed
        shouldRefresh = true
      }
      if (shouldRefresh) {
        this.requestRefresh('amphetamine-probe')
      }
      return installed
    } catch (err) {
      if (!this.disposed) {
        this.logger.warn('[agent-awake] failed to probe for Amphetamine', { error: err })
      }
      return undefined
    }
  }

  start(reason: string): void {
    if (this.disposed) {
      return
    }
    // Caffeinate is Orca's assertion. The optional Amphetamine integration only
    // observes a session the user already started; the global scripting API has
    // no identity or atomic write that could make automatic ownership safe.
    this.startAssertion(this.caffeinateAssertion, 'macOS system sleep', reason)
    if (this.usesAmphetamine()) {
      this.startAmphetamineObservation(reason)
    } else {
      this.stopAmphetamineObservation(reason)
    }
  }

  private startAssertion(assertion: PlatformAwakeAssertion, label: string, reason: string): void {
    try {
      assertion.start(reason)
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to start ${label} assertion`, { reason, error: err })
    }
  }

  stop(reason: string): void {
    if (this.disposed) {
      return
    }
    this.stopAssertion(this.caffeinateAssertion, 'macOS system sleep', reason)
    this.stopAmphetamineObservation(reason)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.probeAbort?.abort()
    this.probeAbort = null
    // Isolate cleanup so one integration cannot skip the other.
    this.disposeAssertion(this.caffeinateAssertion, 'macOS system sleep')
    this.disposeAmphetamineObservation()
  }

  private disposeAssertion(assertion: PlatformAwakeAssertion, label: string): void {
    try {
      assertion.dispose()
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to dispose ${label} assertion`, { error: err })
    }
  }

  statusFields(): MacosAwakeEngineStatusFields {
    if (this.platform !== 'darwin') {
      return {}
    }
    const unavailableReason =
      this.engine === 'amphetamine' ? this.amphetamineObserver.getUnavailableReason() : null
    return {
      macosEngine: this.engine,
      ...(this.amphetamineInstalled === undefined
        ? {}
        : { amphetamineInstalled: this.amphetamineInstalled }),
      ...(unavailableReason ? { amphetamineUnavailableReason: unavailableReason } : {}),
      amphetamineActive: this.usesAmphetamine() && this.amphetamineObserver.isActive()
    }
  }

  /** Observe Amphetamine only when selected and usable; caffeinate always owns Orca's assertion. */
  private usesAmphetamine(): boolean {
    return (
      // The engine setting is writable on every platform, so gate on the host too.
      this.platform === 'darwin' &&
      this.engine === 'amphetamine' &&
      // A known-missing app would otherwise cost a failed Apple event per refresh.
      this.amphetamineInstalled !== false &&
      !this.amphetamineObserver.isUnavailable()
    )
  }

  private startAmphetamineObservation(reason: string): void {
    try {
      this.amphetamineObserver.start(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start Amphetamine observation', {
        reason,
        error: err
      })
    }
  }

  private stopAmphetamineObservation(reason: string): void {
    try {
      this.amphetamineObserver.stop(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop Amphetamine observation', {
        reason,
        error: err
      })
    }
  }

  private disposeAmphetamineObservation(): void {
    try {
      this.amphetamineObserver.dispose()
    } catch (err) {
      this.logger.warn('[agent-awake] failed to dispose Amphetamine observation', { error: err })
    }
  }

  private stopAssertion(assertion: PlatformAwakeAssertion, label: string, reason: string): void {
    try {
      assertion.stop(reason)
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to stop ${label} assertion`, { reason, error: err })
    }
  }

  private requestRefresh(reason: string): void {
    if (!this.disposed) {
      this.onNeedsRefresh(reason)
    }
  }
}
