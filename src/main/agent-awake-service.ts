import { powerMonitor, powerSaveBlocker } from 'electron'
import type { AgentStatusState } from '../shared/agent-status-types'
import { AgentAwakeBlockerSwapRetry } from './agent-awake-blocker-swap-retry'
import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

// Why: the display is the single biggest battery draw and only needs to stay
// lit while an agent is ACTIVELY producing status. Keeping the screen on during
// a long quiet stretch — or after an agent has silently died with its shell
// still open (no terminating hook, so the 2h backstop above is what releases
// it) — wastes power for up to two hours. Once no working status has been
// refreshed within this shorter window, downgrade to a system-only assertion:
// the machine (and the agent) stays awake for the full 2h window, but the
// display is allowed to sleep normally.
//
// Known limitation: "no status for 15m" is a proxy for "idle", so a single
// hook-silent tool call longer than this (e.g. a 30m build streaming output)
// will let the display sleep mid-work; press a key to wake it (the agent keeps
// running). Refreshing this off raw PTY output would keep such screens lit but
// costs the battery win (a spinner counts as output), so it's left as future
// work. The downgrade applies on macOS only (canonical caffeinate floor);
// Windows and Linux keep prevent-display-sleep (see refresh()).
export const AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS = 15 * 60 * 1000

type AgentAwakeBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

export type AgentAwakeStatus = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

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

type AgentAwakeServiceOptions = {
  blocker?: PowerSaveBlocker
  linuxAssertion?: PlatformAwakeAssertion
  logger?: Logger
  macosAssertion?: PlatformAwakeAssertion
  now?: () => number
  platform?: NodeJS.Platform
  powerMonitor?: PowerMonitorEventSource | null
}

export class AgentAwakeService {
  private enabled = false
  private statuses: AgentAwakeStatus[] = []
  private blockerId: number | null = null
  private blockerType: AgentAwakeBlockerType | null = null
  private readonly blockerSwapRetry: AgentAwakeBlockerSwapRetry
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly blocker: PowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macosAssertion: PlatformAwakeAssertion
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: AgentAwakeServiceOptions = {}) {
    this.blocker = options.blocker ?? powerSaveBlocker
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.blockerSwapRetry = new AgentAwakeBlockerSwapRetry(() => this.refresh('blocker-swap-retry'))
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
    const resumeSource = options.powerMonitor === undefined ? powerMonitor : options.powerMonitor
    if (resumeSource) {
      const onResume = () => this.refresh('power-resume')
      resumeSource.on('resume', onResume)
      this.unsubscribeResume = () => resumeSource.off('resume', onResume)
    } else {
      this.unsubscribeResume = null
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return
    }
    this.enabled = enabled
    this.refresh('settings-change')
  }

  setStatuses(statuses: AgentAwakeStatus[]): void {
    this.statuses = statuses.map((status) => ({ ...status }))
    this.refresh('status-change')
  }

  dispose(): void {
    this.clearStaleTimer()
    this.blockerSwapRetry.clear()
    this.unsubscribeResume?.()
    this.stopBlocker('dispose')
    this.macosAssertion.dispose()
    this.linuxAssertion.dispose()
  }

  private refresh(reason: string): void {
    this.scheduleStaleTimer()
    const now = this.now()
    const runningStatusCount = this.getEligibleRunningStatusCount(now)
    const shouldBlock = this.enabled && runningStatusCount > 0
    if (shouldBlock) {
      // Keep the screen lit only while an agent is actively working; once every
      // working status has gone quiet past the display window, downgrade so the
      // display can sleep while the system (and the agent) stays awake.
      //
      // Only downgrade on macOS: `caffeinate -i -s` is a canonical, always-present
      // idle-sleep inhibitor, so dropping the Electron display assertion is safe
      // there. Windows has no independent floor (Modern Standby can suspend the
      // agent once the display sleeps), and on Linux the guarantee depends on the
      // distro's logind idle-action / inhibitor semantics, so both keep
      // prevent-display-sleep — the display assertion is load-bearing for them.
      const canDropDisplayAssertion = this.platform === 'darwin'
      const displayEligibleCount = this.getDisplayEligibleCount(now)
      const desiredType: AgentAwakeBlockerType =
        displayEligibleCount > 0 || !canDropDisplayAssertion
          ? 'prevent-display-sleep'
          : 'prevent-app-suspension'
      this.startBlocker(reason, runningStatusCount, desiredType)
      this.startMacosAssertion(reason)
      this.startLinuxAssertion(reason)
    } else {
      this.blockerSwapRetry.clear()
      this.stopBlocker(reason, runningStatusCount)
      this.stopMacosAssertion(reason)
      this.stopLinuxAssertion(reason)
    }
  }

  private getEligibleRunningStatusCount(now: number): number {
    return this.statuses.filter((status) => this.isWakeEligible(status, now)).length
  }

  private getDisplayEligibleCount(now: number): number {
    return this.statuses.filter(
      (status) =>
        this.isWakeEligible(status, now) &&
        now - status.receivedAt < AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS
    ).length
  }

  private isWakeEligible(status: AgentAwakeStatus, now: number): boolean {
    return (
      status.observedInCurrentRuntime &&
      status.state === 'working' &&
      Number.isFinite(status.receivedAt) &&
      now - status.receivedAt < AGENT_AWAKE_STATUS_STALE_AFTER_MS
    )
  }

  private scheduleStaleTimer(): void {
    this.clearStaleTimer()
    const now = this.now()
    let earliestExpiry: number | null = null
    for (const status of this.statuses) {
      if (
        !status.observedInCurrentRuntime ||
        status.state !== 'working' ||
        !Number.isFinite(status.receivedAt)
      ) {
        continue
      }
      // Wake at BOTH boundaries: the display-keep expiry (downgrade the screen
      // to system-only) and the full stale expiry (release entirely).
      for (const expiry of [
        status.receivedAt + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS,
        status.receivedAt + AGENT_AWAKE_STATUS_STALE_AFTER_MS
      ]) {
        if (expiry <= now) {
          continue
        }
        earliestExpiry = earliestExpiry === null ? expiry : Math.min(earliestExpiry, expiry)
      }
    }
    if (earliestExpiry === null) {
      return
    }
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null
      this.refresh('stale-expiry')
    }, earliestExpiry - now)
    if (typeof this.staleTimer.unref === 'function') {
      this.staleTimer.unref()
    }
  }

  private clearStaleTimer(): void {
    if (!this.staleTimer) {
      return
    }
    clearTimeout(this.staleTimer)
    this.staleTimer = null
  }

  private startBlocker(
    reason: string,
    runningStatusCount: number,
    desiredType: AgentAwakeBlockerType
  ): void {
    // Keep an already-running blocker only if it is the type we want; a
    // display<->system transition must swap the assertion.
    if (this.blockerId !== null && this.blockerType === desiredType) {
      if (this.reconcileBlocker('start-reconcile')) {
        this.blockerSwapRetry.clear()
        return
      }
    }
    // Stop any existing (wrong-type or dead) blocker before starting the new
    // type so a display->system downgrade never leaks the display assertion.
    if (this.blockerId !== null) {
      this.stopBlocker('blocker-type-change', runningStatusCount)
      if (this.blockerId !== null) {
        // The old blocker could not be stopped (stop threw and Electron still
        // reports it started). Do NOT stack a second assertion — keep the
        // current one and make one prompt retry without creating a poll loop.
        this.blockerSwapRetry.schedule(desiredType)
        return
      }
    }
    try {
      const id = this.blocker.start(desiredType)
      this.blockerId = id
      this.blockerType = desiredType
      if (this.reconcileBlocker('post-start')) {
        this.blockerSwapRetry.clear()
      }
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start blocker', {
        reason,
        enabled: this.enabled,
        runningStatusCount,
        blockerType: desiredType,
        error: err
      })
    }
  }

  private startMacosAssertion(reason: string): void {
    try {
      this.macosAssertion.start(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start macOS system sleep assertion', {
        reason,
        enabled: this.enabled,
        error: err
      })
    }
  }

  private startLinuxAssertion(reason: string): void {
    try {
      this.linuxAssertion.start(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start Linux lid sleep assertion', {
        reason,
        enabled: this.enabled,
        error: err
      })
    }
  }

  private stopMacosAssertion(reason: string): void {
    try {
      this.macosAssertion.stop(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop macOS system sleep assertion', {
        reason,
        enabled: this.enabled,
        error: err
      })
    }
  }

  private stopLinuxAssertion(reason: string): void {
    try {
      this.linuxAssertion.stop(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop Linux lid sleep assertion', {
        reason,
        enabled: this.enabled,
        error: err
      })
    }
  }

  private stopBlocker(reason: string, runningStatusCount = 0): void {
    if (this.blockerId === null) {
      return
    }
    const id = this.blockerId
    try {
      this.blocker.stop(id)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop blocker', {
        reason,
        enabled: this.enabled,
        runningStatusCount,
        blockerId: id,
        error: err
      })
    }
    this.reconcileBlocker('post-stop')
    if (this.blockerId === null) {
      this.blockerType = null
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
      this.logger.warn('[agent-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error: err
      })
      return true
    }
  }
}
