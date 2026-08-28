import {
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  PtyConsumerSession,
  type PtyConsumerSessionAdmission,
  type PtyConsumerSessionGrant
} from '../shared/pty-consumer-session'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../shared/pty-source-credit-contract'
import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliverySnapshot,
  PtySourceSpan,
  PtySourceTransform
} from '../shared/pty-source-credit-contract'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { PtySourceSendReservation } from './pty-source-credit-ledger'
import { SshPtySourceCreditAdapter } from './ssh-pty-source-credit-adapter'
import {
  admitsSshPtyDataPublication,
  sshPtyDeliveryMode,
  type SshPtyDeliveryMode
} from './ssh-pty-data-publication-admission'
import { parseOpenClientParams, requireIdentity } from './ssh-pty-open-client-request'

export const SSH_PTY_OPEN_CLIENT_METHOD = 'pty.openClient'

export class SshPtyConsumerSessionAdapter {
  private readonly session: PtyConsumerSession
  private readonly sourceCredit: SshPtySourceCreditAdapter
  private readonly pausedDeliveryByPty = new Map<string, PtySourceDeliveryIdentity>()

  constructor(
    private readonly dispatcher: RelayDispatcher,
    serverBuildId: string,
    private readonly setDeliveryPaused?: (id: string, paused: boolean) => void,
    onSourceCreditAvailable?: (id: string) => void
  ) {
    this.sourceCredit = new SshPtySourceCreditAdapter(
      (proof) =>
        dispatcher.notifyControl(
          'pty.deliveryCanceled',
          proof as unknown as Record<string, unknown>
        ),
      onSourceCreditAvailable
    )
    this.session = new PtyConsumerSession({
      serverBuildId,
      outputFlowControl: { versions: [1], maxWindowSu: DEFAULT_PTY_SOURCE_WINDOW_SU }
    })
    // Why the admission is consulted again at drain time (see isStillAdmitted): a frame can sit
    // queued behind a saturated socket long enough for the grant or the delivery to be retired, and
    // publishing it then hands the client output from an owner it no longer is.
    dispatcher.registerPtyDataPublicationAdmission((clientId, params) =>
      admitsSshPtyDataPublication(
        this.session.activeGrant(String(clientId)),
        params,
        this.sourceCredit
      )
    )
    dispatcher.onRequest(SSH_PTY_OPEN_CLIENT_METHOD, (params, context) =>
      this.openClient(params, context)
    )
    dispatcher.onClientDetached((clientId, cause) => {
      const connectionKey = String(clientId)
      const grant = this.session.activeGrant(connectionKey)
      if (grant) {
        this.clearPausedForGrant(grant)
      }
      this.session.close(connectionKey, cause)
      if (grant) {
        this.sourceCredit.retainOrCloseOnDetach(grant)
      }
    })
    dispatcher.onNotification('pty.setDeliveryPaused', (params, context) => {
      const grant = this.session.activeGrant(String(context.clientId))
      if (
        !grant ||
        grant.clientGeneration !== params.clientGeneration ||
        grant.ownerGeneration !== params.ownerGeneration ||
        typeof params.id !== 'string' ||
        typeof params.paused !== 'boolean'
      ) {
        return
      }
      if (grant.capabilities?.outputFlowControl) {
        const token = typeof params.deliveryToken === 'string' ? params.deliveryToken : ''
        const identity = this.sourceCredit.ownsDelivery(token, grant, params.id)
        if (!identity) {
          return
        }
        if (params.paused) {
          this.pausedDeliveryByPty.set(params.id, identity)
        } else if (this.pausedDeliveryByPty.get(params.id) !== identity) {
          return
        } else {
          this.pausedDeliveryByPty.delete(params.id)
        }
      }
      this.setDeliveryPaused?.(params.id, params.paused)
    })
    dispatcher.onNotification('pty.ackData', (params, context) => {
      this.sourceCredit.acknowledge(params, this.session.activeGrant(String(context.clientId)))
    })
    dispatcher.onRequest('pty.cancelDelivery', async (params, context) =>
      this.sourceCredit.cancel(params, this.session.activeGrant(String(context.clientId)))
    )
    dispatcher.onDisposed(() => {
      for (const id of this.pausedDeliveryByPty.keys()) {
        this.setDeliveryPaused?.(id, false)
      }
      this.pausedDeliveryByPty.clear()
      this.sourceCredit.dispose()
    })
  }

  openDelivery(
    clientId: number,
    id: string,
    ptyIncarnation: string,
    checkpointSourceEndSu = 0
  ): PtySourceDeliveryIdentity | null {
    return this.sourceCredit.open(
      this.session.activeGrant(String(clientId)),
      id,
      ptyIncarnation,
      checkpointSourceEndSu
    )
  }

  rotateDelivery(
    oldIdentity: PtySourceDeliveryIdentity,
    newClientId: number,
    acceptedSourceEndSu: number
  ) {
    this.clearPausedIdentity(oldIdentity)
    return this.sourceCredit.rotate(
      oldIdentity,
      this.session.activeGrant(String(newClientId)),
      acceptedSourceEndSu
    )
  }

  appendSource(
    identity: PtySourceDeliveryIdentity,
    input: Readonly<{
      spanId: string
      data: string
      displayStart: number
      displayEnd: number
      splittable: boolean
      transform: PtySourceTransform
    }>
  ): PtySourceSpan {
    return this.sourceCredit.append(identity, input)
  }

  reserveSourceSend(
    identity: PtySourceDeliveryIdentity,
    maxSourceSu?: number
  ): PtySourceSendReservation | null {
    return this.sourceCredit.reserveSend(identity, maxSourceSu)
  }

  commitSourceSend(reservation: PtySourceSendReservation): void {
    this.sourceCredit.commitSend(reservation)
  }

  rollbackSourceSend(reservation: PtySourceSendReservation): void {
    this.sourceCredit.rollbackSend(reservation)
  }

  sealDelivery(identity: PtySourceDeliveryIdentity): void {
    this.sourceCredit.seal(identity)
  }

  settleExitPublication(
    identity: PtySourceDeliveryIdentity,
    result: { ok: true } | { ok: false; error: Error }
  ): void {
    this.sourceCredit.settleExit(identity, result)
  }

  sourceDeliverySnapshot(identity: PtySourceDeliveryIdentity): PtySourceDeliverySnapshot {
    return this.sourceCredit.snapshot(identity)
  }

  sourceDeliverySnapshotIfKnown(
    identity: PtySourceDeliveryIdentity
  ): PtySourceDeliverySnapshot | null {
    return this.sourceCredit.snapshotIfKnown(identity)
  }

  cancelDelivery(identity: PtySourceDeliveryIdentity, reason: string): void {
    this.clearPausedIdentity(identity)
    this.sourceCredit.cancelIdentity(identity, reason)
  }

  getDebugSnapshot(): Readonly<{
    deliveryTokens: number
    graceTimers: number
    sourceSu: number
    dataBytes: number
    spans: number
  }> {
    return this.sourceCredit.retentionSnapshot()
  }

  deliveryMode(clientId: number): SshPtyDeliveryMode {
    return sshPtyDeliveryMode(this.session.activeGrant(String(clientId)))
  }

  private async openClient(
    rawParams: Record<string, unknown>,
    context: RequestContext
  ): Promise<PtyConsumerSessionGrant> {
    const params = parseOpenClientParams(rawParams)
    if (params.protocolVersion !== PTY_CONSUMER_SESSION_PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported pty.openClient protocol version: ${params.protocolVersion || 'missing'}`
      )
    }
    const identity = requireIdentity(context)
    const admission = this.session.admit(params, {
      connectionId: String(context.clientId),
      principal: identity.principal,
      authenticated: identity.authenticated,
      allowSessionOwner: identity.allowSessionOwner
    })
    if (!context.onResponseSettled) {
      admission.rollbackPublication()
      throw new Error('SSH PTY consumer response publication fence is unavailable')
    }
    context.onResponseSettled((result) => {
      if (!result.ok) {
        admission.rollbackPublication()
        return
      }
      admission.commitPublication()
      this.closeDisplacedOwner(admission.displacedOwner)
    })
    return admission.grant
  }

  // Why: only after the replacement grant is published — until then the admission can still roll back
  // onto the incumbent. Its deliveries are retained for the new owner to rotate, exactly as on detach.
  private closeDisplacedOwner(displaced: PtyConsumerSessionAdmission['displacedOwner']): void {
    if (!displaced) {
      return
    }
    this.clearPausedForGrant(displaced.grant)
    this.sourceCredit.retainOrCloseOnDetach(displaced.grant)
    const clientId = Number(displaced.connectionId)
    if (Number.isSafeInteger(clientId)) {
      this.dispatcher.releaseDisplacedClient(clientId)
    }
  }

  private clearPausedIdentity(identity: PtySourceDeliveryIdentity): void {
    if (this.pausedDeliveryByPty.get(identity.id) === identity) {
      this.pausedDeliveryByPty.delete(identity.id)
      this.setDeliveryPaused?.(identity.id, false)
    }
  }

  private clearPausedForGrant(grant: Readonly<PtyConsumerSessionGrant>): void {
    for (const [id, identity] of this.pausedDeliveryByPty) {
      if (
        identity.clientGeneration !== grant.clientGeneration ||
        identity.ownerGeneration !== grant.ownerGeneration
      ) {
        continue
      }
      this.pausedDeliveryByPty.delete(id)
      this.setDeliveryPaused?.(id, false)
    }
  }
}
