import { powerMonitor } from 'electron'
import type { AgentStatusState } from '../shared/agent-status-types'
import {
  normalizeComputerAwakeMode,
  type ComputerAwakeMode,
  type ComputerAwakeStatus,
  type MacosAwakeEngine
} from '../shared/computer-awake-mode'
import { AgentAwakePowerSaveBlocker, type PowerSaveBlocker } from './agent-awake-power-save-blocker'
import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import {
  MacosAwakeEngineRouter,
  type AmphetamineSessionObserver,
  type PlatformAwakeAssertion
} from './macos-awake-engine'

export type { AmphetamineSessionObserver, PlatformAwakeAssertion }

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export type AgentAwakeStatus = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

type PowerMonitorEventSource = {
  on: (event: 'resume', listener: () => void) => void
  off: (event: 'resume', listener: () => void) => void
}

type Logger = Pick<Console, 'debug' | 'warn'>

export type AgentAwakeServiceOptions = {
  blocker?: PowerSaveBlocker
  detectAmphetamine?: (signal?: AbortSignal) => Promise<boolean | undefined>
  linuxAssertion?: PlatformAwakeAssertion
  logger?: Logger
  macosAmphetamineObserver?: AmphetamineSessionObserver
  macosAssertion?: PlatformAwakeAssertion
  now?: () => number
  platform?: NodeJS.Platform
  powerMonitor?: PowerMonitorEventSource | null
}

export class AgentAwakeService {
  private disposed = false
  private mode: ComputerAwakeMode = 'off'
  private statuses: AgentAwakeStatus[] = []
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly statusListeners = new Set<(status: ComputerAwakeStatus) => void>()
  private lastPublishedStatus: ComputerAwakeStatus | null = null
  private readonly blocker: AgentAwakePowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macos: MacosAwakeEngineRouter
  private readonly now: () => number
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: AgentAwakeServiceOptions = {}) {
    this.logger = options.logger ?? console
    this.blocker = new AgentAwakePowerSaveBlocker(options.blocker, this.logger)
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
    this.macos = new MacosAwakeEngineRouter({
      amphetamineObserver: options.macosAmphetamineObserver,
      caffeinateAssertion: options.macosAssertion,
      detectAmphetamine: options.detectAmphetamine,
      logger: this.logger,
      now: this.now,
      onNeedsRefresh: (reason) => this.refresh(reason),
      platform: options.platform
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
    this.setMode(enabled ? 'auto' : 'off')
  }

  setMode(mode: ComputerAwakeMode): void {
    if (this.disposed) {
      return
    }
    const normalized = normalizeComputerAwakeMode(mode)
    if (this.mode === normalized) {
      return
    }
    this.mode = normalized
    this.refresh('settings-change')
  }

  setMacosEngine(engine: MacosAwakeEngine): void {
    if (this.disposed) {
      return
    }
    if (this.macos.setEngine(engine)) {
      this.refresh('macos-engine-change')
    }
  }

  probeAmphetamine(): Promise<boolean | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined)
    }
    return this.macos.retryUnavailable()
  }

  setStatuses(statuses: AgentAwakeStatus[]): void {
    if (this.disposed) {
      return
    }
    this.statuses = statuses.map((status) => ({ ...status }))
    this.refresh('status-change')
  }

  getStatus(): ComputerAwakeStatus {
    // The picker asks for status when it first renders; that is the cheapest
    // moment to learn whether Amphetamine exists, rather than at every launch.
    if (!this.disposed) {
      void this.macos.probeInstalledIfUnknown()
    }
    const workingAgentCount = this.getEligibleRunningStatusCount()
    return this.decorateStatus({
      mode: this.mode,
      active: this.mode === 'on' || (this.mode === 'auto' && workingAgentCount > 0)
    })
  }

  subscribe(listener: (status: ComputerAwakeStatus) => void): () => void {
    if (this.disposed) {
      return () => {}
    }
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearStaleTimer()
    this.unsubscribeResume?.()
    this.stopBlocker('dispose')
    this.macos.dispose()
    this.linuxAssertion.dispose()
    this.statusListeners.clear()
  }

  private refresh(reason: string): void {
    if (this.disposed) {
      return
    }
    this.scheduleStaleTimer()
    const runningStatusCount = this.getEligibleRunningStatusCount()
    const shouldBlock = this.mode === 'on' || (this.mode === 'auto' && runningStatusCount > 0)
    if (shouldBlock) {
      this.startBlocker(reason, runningStatusCount)
      this.startMacosAssertion(reason)
      this.startLinuxAssertion(reason)
    } else {
      this.stopBlocker(reason, runningStatusCount)
      this.stopMacosAssertion(reason)
      this.stopLinuxAssertion(reason)
    }
    this.publishStatus(shouldBlock)
  }

  private publishStatus(active: boolean): void {
    const status = this.decorateStatus({ mode: this.mode, active })
    if (
      this.lastPublishedStatus?.mode === status.mode &&
      this.lastPublishedStatus.active === status.active &&
      this.lastPublishedStatus.macosEngine === status.macosEngine &&
      this.lastPublishedStatus.amphetamineInstalled === status.amphetamineInstalled &&
      this.lastPublishedStatus.amphetamineUnavailableReason ===
        status.amphetamineUnavailableReason &&
      this.lastPublishedStatus.amphetamineActive === status.amphetamineActive
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
    this.blocker.start(reason, { mode: this.mode, runningStatusCount })
  }

  private decorateStatus(status: {
    mode: ComputerAwakeMode
    active: boolean
  }): ComputerAwakeStatus {
    return { ...status, ...this.macos.statusFields() }
  }

  private startMacosAssertion(reason: string): void {
    this.macos.start(reason)
  }

  private stopMacosAssertion(reason: string): void {
    this.macos.stop(reason)
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
    this.blocker.stop(reason, { mode: this.mode, runningStatusCount })
  }
}
