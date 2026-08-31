export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

export type PowerSaveBlocker = {
  start: (type: PowerSaveBlockerType) => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type Logger = Pick<Console, 'debug' | 'warn'>

type BlockerLogContext = {
  reason: string
  mode: string
  runningStatusCount: number
}

/**
 * Holds at most one Electron power-save blocker and re-scopes it in place when the
 * requested type changes, so callers never leak a blocker across a scope switch.
 */
export class PowerSaveBlockerLease {
  private id: number | null = null
  private type: PowerSaveBlockerType | null = null

  constructor(
    private readonly blocker: PowerSaveBlocker,
    private readonly logger: Logger
  ) {}

  /**
   * Holds a blocker at `type`, swapping scope if one is already live. If the old blocker
   * survives its stop it is kept and the swap is deferred to the next call, because
   * starting a second blocker would leave the first running with nothing tracking its id.
   */
  acquire(type: PowerSaveBlockerType, context: BlockerLogContext): void {
    if (this.id !== null && this.reconcile('start-reconcile')) {
      if (this.type === type) {
        return
      }
      // Why: reconcile before stopping so we never hand the OS an id it already dropped.
      this.release({ ...context, reason: 'blocker-type-change' })
      if (this.id !== null) {
        // Why: the old blocker outlived its stop; starting a second one would strand it forever.
        this.logger.warn('[agent-awake] kept the live blocker after a failed scope change', {
          ...context,
          blockerId: this.id,
          blockerType: this.type,
          requestedType: type
        })
        return
      }
    }
    try {
      this.id = this.blocker.start(type)
      this.type = type
      this.reconcile('post-start')
    } catch (error) {
      this.logger.warn('[agent-awake] failed to start blocker', {
        ...context,
        error
      })
    }
  }

  /** Releases the held blocker; the id is retained if the OS still reports it started. */
  release(context: BlockerLogContext): void {
    if (this.id === null) {
      return
    }
    const id = this.id
    try {
      this.blocker.stop(id)
    } catch (error) {
      this.logger.warn('[agent-awake] failed to stop blocker', {
        ...context,
        blockerId: id,
        error
      })
    }
    this.reconcile('post-stop')
  }

  /** True while the OS still reports the blocker as started. */
  private reconcile(reason: string): boolean {
    if (this.id === null) {
      return false
    }
    const id = this.id
    try {
      const isStarted = this.blocker.isStarted(id)
      if (!isStarted) {
        this.id = null
        this.type = null
      }
      return isStarted
    } catch (error) {
      this.logger.warn('[agent-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error
      })
      return true
    }
  }
}
