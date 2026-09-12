import type { PtyHandler } from './pty-handler'
import {
  applyRelayGraceTimeConfiguration,
  decideRelayGrace,
  type RelayGraceBranch
} from './relay-grace-branch'
import { relayLogLine } from './relay-diagnostic-log'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../shared/ssh-types'
import type { RelayDispatcher, RequestContext } from './dispatcher'

type NetworkTunnelDrain = {
  drain: (signal: AbortSignal) => Promise<void>
  assertDrained: () => void
  seal?: () => void
}

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
  fenceNetworkTunnels?: () => NetworkTunnelDrain
  hasNetworkTunnels?: () => boolean
}

export class RelayGraceLifecycle {
  private graceDeadlineAt: number | null = null
  private graceReason: string | null = null
  private graceBranch: RelayGraceBranch | null = null
  private shutdownInFlight = false
  private shutdownPreparation: Promise<void> | null = null
  private shutdownPrepared = false
  private shutdownInitiator: RequestContext | undefined
  private networkTunnelDrain: NetworkTunnelDrain | undefined
  private stopPoolWatch = (): void => {}
  private stopPoolActiveWatch = (): void => {}

  constructor(private readonly options: RelayGraceLifecycleOptions) {
    options.ptyHandler.setOwnershipTransferGraceGuardEnabled(true)
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
      if (this.options.ptyHandler.hasLiveOwnershipTransferFence) {
        relayLogLine(`[relay] Grace expired (${reason}) with ownership transfer active; deferring`)
        this.start('ownership transfer active')
        return
      }
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
    if (this.options.ptyHandler.hasLiveOwnershipTransferFence) {
      relayLogLine('[relay] Shutdown deferred: ownership transfer active')
      if (this.options.readSocketClientCount() === 0) {
        this.start('ownership transfer active')
      }
      return
    }
    relayLogLine(
      `[relay] Shutdown: ptys=${this.options.ptyHandler.activePtyCount}, clients=${this.options.readSocketClientCount()}, ownsSocket=${this.options.ownsSocketPath()}`
    )
    void this.prepareShutdown()
      .then(() => this.finishShutdown())
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

  /** Leaves transport alive so a host-owned reset can settle its response before exiting. */
  prepareShutdown(initiator?: RequestContext, onAdmitted?: () => void): Promise<void> {
    if (initiator) {
      try {
        this.options.dispatcher.assertActiveWorkContext(initiator)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (this.shutdownPreparation) {
      if (initiator && initiator !== this.shutdownInitiator) {
        return Promise.reject(new Error('relay_shutdown_preparation_in_progress'))
      }
      return this.shutdownPreparation
    }
    if (this.options.ptyHandler.hasLiveOwnershipTransferFence) {
      return Promise.reject(new Error('pty_ownership_transfer_source_shutdown_fenced'))
    }
    try {
      onAdmitted?.()
    } catch (error) {
      return Promise.reject(error)
    }
    this.shutdownInFlight = true
    this.shutdownInitiator = initiator
    let drainage: Promise<void>
    try {
      this.cancel('shutdown preparation')
      this.networkTunnelDrain ??= this.options.fenceNetworkTunnels?.()
      drainage = this.options.dispatcher.beginWorkDrain(initiator)
    } catch (error) {
      this.shutdownInFlight = false
      return Promise.reject(error)
    }
    const tunnelDrain = this.networkTunnelDrain
    let disposal: Promise<void>
    try {
      if (tunnelDrain) {
        this.options.ptyHandler.fenceCreationForShutdown()
        disposal = Promise.resolve()
          .then(() => tunnelDrain.drain(new AbortController().signal))
          .then(() => {
            tunnelDrain.assertDrained()
            tunnelDrain.seal?.()
            return this.options.ptyHandler.dispose()
          })
      } else {
        disposal = this.options.ptyHandler.dispose()
      }
    } catch (error) {
      disposal = Promise.reject(error)
    }
    const preparation = Promise.allSettled([drainage, disposal]).then(async (results) => {
      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length === 1) {
        throw failures[0].reason
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          'relay_shutdown_admitted_work_incomplete'
        )
      }
      await this.options.disposeOwnedProcesses()
      // Cleanup controls may have arrived while owned producers were settling.
      await this.options.dispatcher.beginWorkDrain(initiator)
      tunnelDrain?.assertDrained()
      this.shutdownPrepared = true
    })
    this.shutdownPreparation = preparation.catch((error) => {
      this.shutdownPreparation = null
      this.shutdownInFlight = false
      throw error
    })
    return this.shutdownPreparation
  }

  finishShutdown(): void {
    if (!this.shutdownPrepared) {
      throw new Error('relay_shutdown_preparation_required')
    }
    this.networkTunnelDrain?.assertDrained()
    this.stopPoolWatch()
    this.stopPoolActiveWatch()
    this.options.disposeRuntime()
    process.exit(0)
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
      !this.options.hasNetworkTunnels?.() &&
      this.options.ptyHandler.pendingPtyCreationCount === 0
    )
  }
}
