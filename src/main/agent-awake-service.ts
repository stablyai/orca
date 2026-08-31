import { powerMonitor, powerSaveBlocker } from 'electron'
import type { AgentStatusState } from '../shared/agent-status-types'
import {
  normalizeComputerAwakeMode,
  type ComputerAwakeMode,
  type ComputerAwakeStatus
} from '../shared/computer-awake-mode'
import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import {
  PowerSaveBlockerLease,
  type PowerSaveBlocker,
  type PowerSaveBlockerType
} from './power-save-blocker-lease'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export type AgentAwakeStatus = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

type PlatformAwakeAssertion = {
  start: (reason: string) => boolean | void
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
  private mode: ComputerAwakeMode = 'off'
  private statuses: AgentAwakeStatus[] = []
  private readonly blockerLease: PowerSaveBlockerLease
  private keepScreenOn = false
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly statusListeners = new Set<(status: ComputerAwakeStatus) => void>()
  private lastPublishedStatus: ComputerAwakeStatus | null = null
  private readonly blocker: PowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macosAssertion: PlatformAwakeAssertion
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: AgentAwakeServiceOptions = {}) {
    this.blocker = options.blocker ?? powerSaveBlocker
    this.logger = options.logger ?? console
    this.blockerLease = new PowerSaveBlockerLease(this.blocker, this.logger)
    this.now = options.now ?? Date.now
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
    this.platform = options.platform ?? process.platform
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
    this.setMode(enabled ? 'auto' : 'off')
  }

  setMode(mode: ComputerAwakeMode): void {
    const normalized = normalizeComputerAwakeMode(mode)
    if (this.mode === normalized) {
      return
    }
    this.mode = normalized
    this.refresh('settings-change')
  }

  /** Opts the display in or out of the awake assertion; does not change whether one is held. */
  setKeepScreenOn(keepScreenOn: boolean): void {
    if (this.keepScreenOn === keepScreenOn) {
      return
    }
    this.keepScreenOn = keepScreenOn
    this.refresh('settings-change')
  }

  setStatuses(statuses: AgentAwakeStatus[]): void {
    this.statuses = statuses.map((status) => ({ ...status }))
    this.refresh('status-change')
  }

  getStatus(): ComputerAwakeStatus {
    const workingAgentCount = this.getEligibleRunningStatusCount()
    return {
      mode: this.mode,
      active: this.mode === 'on' || (this.mode === 'auto' && workingAgentCount > 0)
    }
  }

  subscribe(listener: (status: ComputerAwakeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  dispose(): void {
    this.clearStaleTimer()
    this.unsubscribeResume?.()
    this.stopBlocker('dispose')
    this.macosAssertion.dispose()
    this.linuxAssertion.dispose()
  }

  private refresh(reason: string): void {
    this.scheduleStaleTimer()
    const runningStatusCount = this.getEligibleRunningStatusCount()
    const shouldBlock = this.mode === 'on' || (this.mode === 'auto' && runningStatusCount > 0)
    if (shouldBlock) {
      const macosAssertionActive = this.startMacosAssertion(reason)
      if (this.platform !== 'darwin' || !macosAssertionActive) {
        this.startBlocker(reason, runningStatusCount)
      } else {
        this.stopBlocker('macos-assertion-active', runningStatusCount)
      }
      this.startLinuxAssertion(reason)
    } else {
      this.stopBlocker(reason, runningStatusCount)
      this.stopMacosAssertion(reason)
      this.stopLinuxAssertion(reason)
    }
    this.publishStatus(shouldBlock)
  }

  private publishStatus(active: boolean): void {
    const status = { mode: this.mode, active }
    if (
      this.lastPublishedStatus?.mode === status.mode &&
      this.lastPublishedStatus.active === status.active
    ) {
      return
    }
    this.lastPublishedStatus = status
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }

  private getEligibleRunningStatusCount(): number {
    const now = this.now()
    return this.statuses.filter((status) => this.isWakeEligible(status, now)).length
  }

  private isWakeEligible(status: AgentAwakeStatus, now: number): boolean {
    return (
      status.observedInCurrentRuntime &&
      status.state === 'working' &&
      Number.isFinite(status.receivedAt) &&
      now - status.receivedAt <= AGENT_AWAKE_STATUS_STALE_AFTER_MS
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
      const expiry = status.receivedAt + AGENT_AWAKE_STATUS_STALE_AFTER_MS
      if (expiry <= now) {
        continue
      }
      earliestExpiry = earliestExpiry === null ? expiry : Math.min(earliestExpiry, expiry)
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

  private startBlocker(reason: string, runningStatusCount: number): void {
    // Why: plain terminal `caffeinate` (-i) holds the system only; pinning the display is opt-in.
    const type: PowerSaveBlockerType = this.keepScreenOn
      ? 'prevent-display-sleep'
      : 'prevent-app-suspension'
    this.blockerLease.acquire(type, { reason, mode: this.mode, runningStatusCount })
  }

  private startMacosAssertion(reason: string): boolean {
    try {
      return this.macosAssertion.start(reason) !== false
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start macOS system sleep assertion', {
        reason,
        mode: this.mode,
        error: err
      })
      return false
    }
  }

  private startLinuxAssertion(reason: string): void {
    try {
      this.linuxAssertion.start(reason)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start Linux lid sleep assertion', {
        reason,
        mode: this.mode,
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
        mode: this.mode,
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
        mode: this.mode,
        error: err
      })
    }
  }

  private stopBlocker(reason: string, runningStatusCount = 0): void {
    this.blockerLease.release({ reason, mode: this.mode, runningStatusCount })
  }
}
