import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS } from './immediate-kill-reply-budget'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

/** Owns unconfirmed attempts without exposing them through public session lookup. */
export class TerminalStartupSession {
  current: Session | undefined
  observedBeforeConfirmation = false
  private published = false
  private discarding = false
  private exited = false
  private handle: SubprocessHandle | undefined
  private discardNative: (() => Promise<void>) | undefined
  private physicalExit = new PhysicalExitTracker()

  constructor(
    private readonly id: string,
    private readonly pending: Map<string, TerminalStartupSession>,
    private create:
      | ((handle: SubprocessHandle, onExit: () => void, synchronous: boolean) => Session)
      | undefined,
    private readonly onExit: () => void
  ) {}

  async clearPreviousAttempt(): Promise<void> {
    const previous = this.pending.get(this.id)
    if (previous) {
      await previous.discard()
      if (this.pending.get(this.id) === previous) {
        this.pending.delete(this.id)
      }
    }
  }

  prepare(
    createHandle: () => SubprocessHandle,
    synchronous: boolean,
    discardNative?: () => Promise<void>
  ): Session {
    if (!this.create) {
      throw new Error('Terminal startup attempt is already published')
    }
    if (this.current) {
      throw new Error('Previous terminal spawn attempt still owns its process')
    }
    this.observedBeforeConfirmation = synchronous
    this.exited = false
    this.discarding = false
    this.discardNative = discardNative
    this.physicalExit = new PhysicalExitTracker()
    this.pending.set(this.id, this)
    let session: Session
    try {
      const handle = createHandle()
      this.handle = handle
      session = this.create(
        handle,
        () => {
          this.physicalExit.markExited()
          this.exited = true
          if (this.published) {
            this.onExit()
          } else if (this.discarding) {
            queueMicrotask(() => this.releaseExitedAttempt())
          }
        },
        synchronous
      )
    } catch (error) {
      this.handle?.onExit(() => this.physicalExit.markExited())
      throw error
    }
    this.current = session
    return session
  }

  async discard(): Promise<void> {
    const session = this.current
    this.discarding = true
    if (session) {
      await session.forceKillAndDisposeSubprocess()
    } else if (this.discardNative) {
      await this.discardNative()
      this.handle?.dispose()
      this.handle = undefined
      this.discardNative = undefined
      if (this.pending.get(this.id) === this) {
        this.pending.delete(this.id)
      }
      return
    } else if (this.handle) {
      this.handle.forceKill()
      await this.physicalExit.waitForExit(
        IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
        () => new Error('Unconfirmed terminal process has not exited')
      )
      this.handle.dispose()
      this.handle = undefined
      if (this.pending.get(this.id) === this) {
        this.pending.delete(this.id)
      }
      return
    }
    this.releaseExitedAttempt()
  }

  private releaseExitedAttempt(): void {
    const session = this.current
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    if (this.pending.get(this.id) === this) {
      this.pending.delete(this.id)
    }
    this.current = undefined
    this.handle = undefined
    this.discardNative = undefined
  }

  publish(): void {
    const session = this.current
    if (!session) {
      throw new Error('Terminal startup attempt is unavailable')
    }
    if (this.pending.get(this.id) === this) {
      this.pending.delete(this.id)
    }
    this.create = undefined
    this.handle = undefined
    this.discardNative = undefined
    this.published = true
    if (this.exited) {
      this.onExit()
    }
  }
}
