import type { DaemonClient } from '../../transport/client/daemon-client'
import { createPtyExitPayload, emitPtyListeners } from './daemon-pty-listener-emission'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import type { DaemonPtyAdapterOptions } from './daemon-pty-adapter-options'
import {
  confirmPreservedEndpointLoss,
  PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS,
  preservedDaemonProcessExited
} from './daemon-preserved-endpoint-loss'

/**
 * A daemon kept from an older Orca version has no respawn. Why (#38432): when it died, nothing
 * ended its PTYs, so every pane stayed "connected" on a frozen frame and input went nowhere.
 */
export abstract class DaemonPtyPreservedHostLoss extends DaemonPtyDaemonRecovery {
  private readonly preservedEndpointLossProbeDelaysMs: readonly number[]
  private readonly preservedDaemonExited: (pid: number | undefined) => boolean
  private preservedEndpointLossProbe: Promise<void> | null = null
  /** Set once this adapter ended its sessions because its endpoint stayed gone. */
  private preservedEndpointLossDeclared = false

  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    this.preservedEndpointLossProbeDelaysMs =
      opts.preservedEndpointLossProbeDelaysMs ?? PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS
    this.preservedDaemonExited = opts.preservedDaemonExited ?? preservedDaemonProcessExited
  }

  getProviderProcessClient(): DaemonClient | null {
    return this.protocolVersion >= 57 ? this.client : null
  }

  protected recoverAfterEndpointLoss(): void {
    if (this.respawnFn || this.activeSessionIds.size === 0) {
      super.recoverAfterEndpointLoss()
      return
    }
    this.confirmPreservedDaemonLoss()
  }

  // A host proven gone runs no session, so restores (attached or not) route to the current daemon.
  async probePtyLiveness(id: string): Promise<boolean | null> {
    return this.isProvenGone() ? false : await super.probePtyLiveness(id)
  }

  listsSession(id: string): Promise<boolean | null> {
    return this.isProvenGone() ? Promise.resolve(false) : super.listsSession(id)
  }

  /** Proven gone and not reconnected since; a later reconnect restores the daemon's own answers. */
  private isProvenGone(): boolean {
    return this.preservedEndpointLossDeclared && !this.client.isConnected()
  }

  private confirmPreservedDaemonLoss(): void {
    if (this.preservedEndpointLossProbe || this.respawnAdoptionClosed) {
      return
    }
    const stillLost = (): boolean =>
      !this.respawnAdoptionClosed && this.activeSessionIds.size > 0 && !this.client.isConnected()
    const probe = confirmPreservedEndpointLoss({
      connect: () => this.ensureConnected(),
      shouldContinue: stillLost,
      processExited: () => this.preservedDaemonExited(this.lastAuthenticatedIdentity?.pid),
      delaysMs: this.preservedEndpointLossProbeDelaysMs
    })
      .then((verdict) => {
        if (verdict === 'gone' && stillLost()) {
          this.endPreservedSessionsAsHostLoss()
        }
      })
      .catch((error) => console.warn('[daemon] Preserved terminal host loss check failed:', error))
      .finally(() => {
        if (this.preservedEndpointLossProbe === probe) {
          this.preservedEndpointLossProbe = null
        }
      })
    this.preservedEndpointLossProbe = probe
  }

  /** Each PTY ends as host loss with its history kept, so its pane can cold-restore. */
  private endPreservedSessionsAsHostLoss(): void {
    const ids = [...this.activeSessionIds]
    console.warn(
      `[daemon] Terminal host v${this.protocolVersion} is gone - ending ${ids.length} session${ids.length === 1 ? '' : 's'} as host loss`
    )
    this.preservedEndpointLossDeclared = true
    const exits = ids.map((id) => {
      const incarnationId = this.sessionIncarnations.get(id)
      this.hostLossSessionIds.add(id)
      this.clearExitedSessionState(id, -1, incarnationId, { closeHistory: false })
      return createPtyExitPayload(id, { code: -1, incarnationId, hostLost: true })
    })
    // State is settled for every session first, so one throwing listener cannot strand the rest.
    for (const exit of exits) {
      try {
        emitPtyListeners(this.exitListeners, (listener) => listener(exit))
      } catch (error) {
        console.warn('[daemon] Host-loss exit listener failed:', exit.id, error)
      }
    }
  }
}
