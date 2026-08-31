import { powerSaveBlocker } from 'electron'

export type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type Logger = Pick<Console, 'debug' | 'warn'>
type BlockerReconcileReason = 'start-reconcile' | 'post-start' | 'post-stop'
type BlockerStartedState = 'started' | 'stopped' | 'unverifiable'

export const AGENT_AWAKE_BLOCKER_RETRY_MS = 30_000

/** Extra fields the caller wants on every warning, so log payloads stay diagnosable. */
export type BlockerLogContext = Record<string, unknown>

/**
 * Owns Electron power-save blocker IDs across unverifiable replacement attempts.
 *
 * Re-read Electron's ID state after starts and failed stops so an unconfirmed
 * transition never discards an owned blocker ID.
 */
export class AgentAwakePowerSaveBlocker {
  private readonly blocker: PowerSaveBlocker
  private readonly logger: Logger
  private blockerId: number | null = null
  private readonly fallbackBlockerIds = new Set<number>()
  private desired = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(blocker: PowerSaveBlocker = powerSaveBlocker, logger: Logger = console) {
    this.blocker = blocker
    this.logger = logger
  }

  start(reason: string, context: BlockerLogContext = {}): void {
    this.desired = true
    while (this.blockerId !== null || this.promoteFallback()) {
      const id = this.blockerId
      if (id === null) {
        break
      }
      const state = this.readStartedState(id, 'start-reconcile')
      if (state === 'started') {
        this.clearRetry()
        this.cleanupFallbacks(reason, context)
        return
      }
      if (state === 'unverifiable') {
        if (this.fallbackBlockerIds.size === 0) {
          this.replaceUnverifiable(id, reason, context)
        }
        this.scheduleRetry(context)
        return
      }
      this.forget(id)
    }
    this.startFresh(reason, context)
  }

  private startFresh(reason: string, context: BlockerLogContext): void {
    try {
      this.blockerId = this.blocker.start('prevent-display-sleep')
      const state = this.readStartedState(this.blockerId, 'post-start')
      if (state === 'stopped') {
        this.blockerId = null
      }
      if (state === 'started') {
        this.clearRetry()
      } else {
        this.scheduleRetry(context)
      }
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start blocker', { reason, ...context, error: err })
      this.scheduleRetry(context)
    }
  }

  stop(reason: string, context: BlockerLogContext = {}): void {
    this.desired = false
    this.clearRetry()
    const ids = new Set(this.fallbackBlockerIds)
    if (this.blockerId !== null) {
      ids.add(this.blockerId)
    }
    for (const id of ids) {
      this.stopOwnedId(id, reason, context)
    }
  }

  private stopOwnedId(id: number, reason: string, context: BlockerLogContext): void {
    try {
      this.blocker.stop(id)
      this.forget(id)
      return
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop blocker', {
        reason,
        ...context,
        blockerId: id,
        error: err
      })
    }
    if (this.readStartedState(id, 'post-stop') === 'stopped') {
      this.forget(id)
    }
  }

  private readStartedState(id: number, reason: BlockerReconcileReason): BlockerStartedState {
    try {
      return this.blocker.isStarted(id) ? 'started' : 'stopped'
    } catch (err) {
      this.logger.warn('[agent-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error: err
      })
      return 'unverifiable'
    }
  }

  private replaceUnverifiable(
    previousId: number,
    reason: string,
    context: BlockerLogContext
  ): void {
    let replacementId: number
    try {
      replacementId = this.blocker.start('prevent-display-sleep')
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start blocker', { reason, ...context, error: err })
      return
    }
    if (replacementId === previousId) {
      return
    }
    const state = this.readStartedState(replacementId, 'post-start')
    if (state === 'stopped') {
      return
    }
    this.blockerId = replacementId
    this.fallbackBlockerIds.add(previousId)
    if (state === 'started') {
      this.stopOwnedId(previousId, 'replacement-cleanup', context)
    }
  }

  private cleanupFallbacks(reason: string, context: BlockerLogContext): void {
    for (const id of this.fallbackBlockerIds) {
      this.stopOwnedId(id, reason, context)
    }
    if (this.fallbackBlockerIds.size > 0) {
      this.scheduleRetry(context)
    }
  }

  private promoteFallback(): boolean {
    const next = this.fallbackBlockerIds.values().next()
    if (next.done) {
      return false
    }
    this.fallbackBlockerIds.delete(next.value)
    this.blockerId = next.value
    return true
  }

  private forget(id: number): void {
    if (this.blockerId === id) {
      this.blockerId = null
    }
    this.fallbackBlockerIds.delete(id)
  }

  private scheduleRetry(context: BlockerLogContext): void {
    if (!this.desired || this.retryTimer) {
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.desired) {
        this.start('blocker-retry', context)
      }
    }, AGENT_AWAKE_BLOCKER_RETRY_MS)
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref()
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
