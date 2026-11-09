import { createPtyExitPayload, emitPtyListeners } from './daemon-pty-listener-emission'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import type { DaemonPtyAdapterOptions } from './daemon-pty-adapter-options'
import {
  confirmPreservedEndpointLoss,
  PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS
} from './daemon-preserved-endpoint-loss'

/**
 * A daemon kept from an older Orca version has no respawn. Why (#38432): when it died, nothing
 * ended its PTYs, so every pane stayed "connected" on a frozen frame and input went nowhere.
 */
export abstract class DaemonPtyPreservedHostLoss extends DaemonPtyDaemonRecovery {
  private readonly preservedEndpointLossProbeDelaysMs: readonly number[]
  private preservedEndpointLossProbe: Promise<void> | null = null
  /** Set once this adapter ended its sessions because its endpoint stayed gone. */
  private preservedEndpointLossDeclared = false

  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    this.preservedEndpointLossProbeDelaysMs =
      opts.preservedEndpointLossProbeDelaysMs ?? PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS
  }

  protected recoverAfterEndpointLoss(): void {
    if (this.respawnFn || this.activeSessionIds.size === 0) {
      super.recoverAfterEndpointLoss()
      return
    }
    this.confirmPreservedDaemonLoss()
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    // Proven endpoint loss lets the pane's restore route to the current daemon.
    return this.isDeclaredLostSession(id) ? false : await super.probePtyLiveness(id)
  }

  listsSession(id: string): Promise<boolean | null> {
    return this.isDeclaredLostSession(id) ? Promise.resolve(false) : super.listsSession(id)
  }

  /** A session this adapter ended as host loss while its endpoint is still unreachable. */
  private isDeclaredLostSession(id: string): boolean {
    return (
      this.preservedEndpointLossDeclared &&
      this.hostLossSessionIds.has(id) &&
      !this.client.isConnected()
    )
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
    for (const id of ids) {
      const incarnationId = this.sessionIncarnations.get(id)
      const hostLoss = { code: -1, incarnationId, hostLost: true as const }
      this.hostLossSessionIds.add(id)
      this.clearExitedSessionState(id, hostLoss.code, incarnationId, { closeHistory: false })
      emitPtyListeners(this.exitListeners, (listener) =>
        listener(createPtyExitPayload(id, hostLoss))
      )
    }
  }
}
