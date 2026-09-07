import type { PtyHandler } from './pty-handler'
import {
  applyRelayGraceTimeConfiguration,
  decideRelayGrace,
  type RelayGraceBranch
} from './relay-grace-branch'
import { relayLogLine } from './relay-diagnostic-log'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../shared/ssh-types'
import type { RelayDispatcher } from './dispatcher'

type RelayGraceLifecycleOptions = {
  dispatcher: RelayDispatcher
  ptyHandler: PtyHandler
  detached: boolean
  emptyDetachedStartupGraceMs: number
  idleRelayGraceMs: number
  readSocketClientCount: () => number
  hasAcceptedSocketClient: () => boolean
  ownsSocketPath: () => boolean
  disposeOwnedProcesses: () => Promise<void>
  disposeRuntime: () => void
}

export class RelayGraceLifecycle {
  private graceDeadlineAt: number | null = null
  private graceReason: string | null = null
  private graceBranch: RelayGraceBranch | null = null
  private shutdownInFlight = false
  private stopPoolWatch = (): void => {}
  private stopPoolActiveWatch = (): void => {}

  constructor(private readonly options: RelayGraceLifecycleOptions) {
    options.dispatcher.onNotification(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, (params) => {
      this.configure(params)
    })
    options.dispatcher.onRequest(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, async (params) =>
      this.configure(params)
    )
  }

  get deadlineAt(): number | null {
    return this.graceDeadlineAt
  }

  get reason(): string | null {
    return this.graceReason
  }

  cancel(reason: string): void {
    if (this.options.ptyHandler.graceTimerActive) {
      relayLogLine(`[relay] Grace canceled: ${reason}`)
    }
    this.graceDeadlineAt = null
    this.graceReason = null
    this.graceBranch = null
    this.options.ptyHandler.cancelGraceTimer()
  }

  start(reason: string, options?: { retryDeferredShutdown?: boolean }): void {
    const decision = decideRelayGrace({
      configuredGraceMs: this.options.ptyHandler.configuredGraceTimeMs,
      relayIdle: this.isRelayIdle(),
      detached: this.options.detached,
      hasAcceptedSocketClient: this.options.hasAcceptedSocketClient(),
      activePtyCount: this.options.ptyHandler.activePtyCount,
      retryDeferredShutdown: options?.retryDeferredShutdown === true,
      emptyDetachedStartupGraceMs: this.options.emptyDetachedStartupGraceMs,
      idleRelayGraceMs: this.options.idleRelayGraceMs
    })
    this.graceBranch = decision.branch
    this.graceDeadlineAt = decision.timeoutMs === 0 ? null : Date.now() + decision.timeoutMs
    this.graceReason = reason
    relayLogLine(
      `[relay] Grace started (${reason}): timeoutMs=${decision.timeoutMs}, branch=${this.graceBranch}, ptys=${this.options.ptyHandler.activePtyCount}, clients=${this.options.readSocketClientCount()}`
    )
    this.options.ptyHandler.startGraceTimer(() => {
      if (this.graceBranch === 'idle-no-ptys' && !this.isRelayIdle()) {
        relayLogLine(`[relay] Grace expired (${reason}) but relay is no longer idle; re-evaluating`)
        this.start(reason)
        return
      }
      relayLogLine(`[relay] Grace expired (${reason}); shutting down`)
      this.shutdown()
    }, decision.timeoutMs)
  }

  installProcessLifecycle(): void {
    this.stopPoolWatch = this.options.ptyHandler.onPtyPoolEmpty(() => {
      if (this.graceReason !== null && this.graceDeadlineAt === null && !this.shutdownInFlight) {
        this.start('last pty exited')
      }
    })
    this.stopPoolActiveWatch = this.options.ptyHandler.onPtyPoolActive(() => {
      if (
        this.graceBranch === 'idle-no-ptys' &&
        this.graceReason !== null &&
        !this.shutdownInFlight
      ) {
        this.start(this.graceReason)
      }
    })
    process.on('SIGTERM', this.shutdown)
    process.on('SIGINT', this.shutdown)
    process.on('SIGHUP', () => {
      relayLogLine('[relay] Received SIGHUP (SSH session dropped), ignoring')
    })
    process.on('exit', (code) => {
      relayLogLine(`[relay] Process exiting with code ${code}`)
    })
  }

  readonly shutdown = (): void => {
    if (this.shutdownInFlight) {
      return
    }
    this.shutdownInFlight = true
    relayLogLine(
      `[relay] Shutdown: ptys=${this.options.ptyHandler.activePtyCount}, clients=${this.options.readSocketClientCount()}, ownsSocket=${this.options.ownsSocketPath()}`
    )
    this.graceDeadlineAt = null
    this.graceReason = null
    this.graceBranch = null
    void this.options.ptyHandler
      .dispose()
      .then(async () => {
        await this.options.disposeOwnedProcesses()
        this.stopPoolWatch()
        this.stopPoolActiveWatch()
        this.options.disposeRuntime()
        process.exit(0)
      })
      .catch((error) => {
        this.shutdownInFlight = false
        relayLogLine(
          `[relay] Shutdown deferred: ${error instanceof Error ? error.message : String(error)}`
        )
        if (this.options.readSocketClientCount() === 0) {
          this.start('shutdown deferred', { retryDeferredShutdown: true })
        }
      })
  }

  private configure(params: Record<string, unknown>): { graceTimeMs: number } {
    return applyRelayGraceTimeConfiguration(params.graceTimeSeconds, {
      readConfiguredGraceMs: () => this.options.ptyHandler.configuredGraceTimeMs,
      writeConfiguredGraceMs: (graceMs) => this.options.ptyHandler.setGraceTimeMs(graceMs),
      isGraceTimerArmed: () => this.graceDeadlineAt !== null && this.graceReason !== null,
      isShutdownInFlight: () => this.shutdownInFlight,
      readGraceBranch: () => this.graceBranch,
      startGrace: (reason, startOptions) => this.start(reason, startOptions)
    })
  }

  private isRelayIdle(): boolean {
    return (
      this.options.ptyHandler.activePtyCount === 0 &&
      this.options.ptyHandler.pendingPtyCreationCount === 0
    )
  }
}
