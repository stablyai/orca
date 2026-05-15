import { powerSaveBlocker } from 'electron'
import type { AgentStatusState } from '../shared/agent-status-types'

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export type AgentAwakeStatus = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type Logger = Pick<Console, 'debug' | 'warn'>

type AgentAwakeServiceOptions = {
  blocker?: PowerSaveBlocker
  logger?: Logger
  now?: () => number
}

export class AgentAwakeService {
  private enabled = false
  private statuses: AgentAwakeStatus[] = []
  private blockerId: number | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly blocker: PowerSaveBlocker
  private readonly logger: Logger
  private readonly now: () => number

  constructor(options: AgentAwakeServiceOptions = {}) {
    this.blocker = options.blocker ?? powerSaveBlocker
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
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
    this.stopBlocker('dispose')
  }

  private refresh(reason: string): void {
    this.scheduleStaleTimer()
    const runningStatusCount = this.getEligibleRunningStatusCount()
    const shouldBlock = this.enabled && runningStatusCount > 0
    this.logger.debug('[agent-awake] refresh', {
      reason,
      enabled: this.enabled,
      runningStatusCount,
      shouldBlock,
      blockerId: this.blockerId
    })
    if (shouldBlock) {
      this.startBlocker(reason, runningStatusCount)
    } else {
      this.stopBlocker(reason, runningStatusCount)
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
    if (this.blockerId !== null) {
      if (this.reconcileBlocker('start-reconcile')) {
        return
      }
    }
    try {
      const id = this.blocker.start('prevent-app-suspension')
      this.blockerId = id
      this.logger.debug('[agent-awake] started blocker', {
        reason,
        enabled: this.enabled,
        runningStatusCount,
        blockerId: id
      })
      this.reconcileBlocker('post-start')
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start blocker', {
        reason,
        enabled: this.enabled,
        runningStatusCount,
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
    if (!this.reconcileBlocker('post-stop')) {
      this.logger.debug('[agent-awake] stopped blocker', {
        reason,
        enabled: this.enabled,
        runningStatusCount,
        blockerId: id
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
      this.logger.debug('[agent-awake] reconciled blocker', {
        reason,
        blockerId: id,
        isStarted
      })
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
