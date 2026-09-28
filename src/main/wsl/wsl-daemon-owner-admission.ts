import {
  wslDaemonIncarnationSchema,
  type PersistedWslDaemonEndpoint
} from '../../shared/wsl-daemon-recovery'
import type { WslPtyOwner } from '../../shared/wsl-pty-id'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import type { Store } from '../persistence'
import { proveWslDaemonIncarnationExited } from './wsl-daemon-incarnation'
import {
  startPreparedWslDaemonOwner,
  startRetainedWslDaemonOwner,
  type PreparedWslDaemonEndpoint
} from './wsl-daemon-endpoint'

export class WslDaemonAdmissionError extends Error {}

/** Durable incarnation admission fences cold restore from displaced but still-live owners. */
export class WslDaemonOwnerAdmission {
  private pending = Promise.resolve()

  constructor(
    private readonly store: Pick<Store, 'getWslDaemonRecovery' | 'upsertWslDaemonRecovery'>,
    private readonly owner: WslPtyOwner,
    private readonly endpoint: PersistedWslDaemonEndpoint,
    private readonly signal: AbortSignal,
    private readonly prepared?: PreparedWslDaemonEndpoint
  ) {}

  admitIdentity = (identity: DaemonEndpointIdentity | null): Promise<void> => {
    const pending = this.pending
      .then(() => this.admit(identity))
      .catch((cause) => {
        throw new WslDaemonAdmissionError(
          `WSL daemon identity could not be durably admitted: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause }
        )
      })
    this.pending = pending.catch(() => {})
    return pending
  }

  private async admit(identity: DaemonEndpointIdentity | null): Promise<void> {
    this.signal.throwIfAborted()
    const parsed = wslDaemonIncarnationSchema.safeParse(
      identity && {
        pid: identity.pid,
        startedAtMs: identity.startedAtMs,
        launchNonce: identity.launchNonce,
        linuxStartTicks: identity.linuxStartTicks,
        bootId: identity.bootId
      }
    )
    const previous = this.store.getWslDaemonRecovery(this.owner)
    const incarnation = parsed.success ? parsed.data : undefined
    if (
      previous?.incarnation &&
      JSON.stringify(previous.incarnation) !== JSON.stringify(incarnation)
    ) {
      if (!incarnation) {
        throw new Error('Authenticated guest owner has no incarnation evidence')
      }
      await proveWslDaemonIncarnationExited(this.endpoint, previous.incarnation, this.signal)
    }
    await this.store.upsertWslDaemonRecovery(
      {
        kind: 'daemon',
        ...this.owner,
        endpoint: this.endpoint,
        ...(incarnation ? { incarnation } : {})
      },
      previous?.incarnation ?? null
    )
    this.signal.throwIfAborted()
  }

  recover = async (): Promise<void> => {
    this.signal.throwIfAborted()
    const previous = this.store.getWslDaemonRecovery(this.owner)
    if (previous) {
      await startRetainedWslDaemonOwner(this.endpoint, previous.incarnation, this.signal)
    } else if (this.prepared) {
      await startPreparedWslDaemonOwner(this.prepared, this.signal)
    } else {
      throw new Error('WSL daemon owner endpoint is unverifiable')
    }
    this.signal.throwIfAborted()
  }

  async establishLease(establish: () => Promise<void>): Promise<void> {
    try {
      await establish()
    } catch (error) {
      if (error instanceof WslDaemonAdmissionError) {
        throw error
      }
      await this.recover()
      await establish()
    }
  }
}
