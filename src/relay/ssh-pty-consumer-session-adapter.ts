import {
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  PtyConsumerSession,
  type PtyConsumerSessionGrant,
  type PtyConsumerSessionHello
} from '../shared/pty-consumer-session'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../shared/pty-source-credit-contract'
import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliverySnapshot,
  PtySourceSpan,
  PtySourceTransform
} from '../shared/pty-source-credit-contract'
import type { RelayClientSessionIdentity, RelayDispatcher, RequestContext } from './dispatcher'
import type { PtySourceSendReservation } from './pty-source-credit-ledger'
import { SshPtySourceCreditAdapter } from './ssh-pty-source-credit-adapter'

export const SSH_PTY_OPEN_CLIENT_METHOD = 'pty.openClient'

type OpenClientParams = PtyConsumerSessionHello & {
  protocolVersion: number
}

function parseOpenClientParams(params: Record<string, unknown>): OpenClientParams {
  const resume =
    typeof params.resume === 'object' && params.resume !== null
      ? (params.resume as Record<string, unknown>)
      : undefined
  const capabilities =
    typeof params.capabilities === 'object' && params.capabilities !== null
      ? (params.capabilities as Record<string, unknown>)
      : undefined
  const outputFlowControl =
    typeof capabilities?.outputFlowControl === 'object' && capabilities.outputFlowControl !== null
      ? (capabilities.outputFlowControl as Record<string, unknown>)
      : undefined
  return {
    protocolVersion: Number(params.protocolVersion),
    clientInstanceId: String(params.clientInstanceId ?? ''),
    requestedRole: String(params.requestedRole ?? '') as PtyConsumerSessionHello['requestedRole'],
    ...(resume
      ? {
          resume: {
            ownerGeneration: Number(resume.ownerGeneration),
            ownerLease: String(resume.ownerLease ?? '')
          }
        }
      : {}),
    ...(outputFlowControl
      ? {
          capabilities: {
            outputFlowControl: {
              versions: Array.isArray(outputFlowControl.versions)
                ? outputFlowControl.versions.map(Number)
                : [],
              requestedWindowSu: Number(outputFlowControl.requestedWindowSu)
            }
          }
        }
      : {})
  }
}

function requireIdentity(context: RequestContext): RelayClientSessionIdentity {
  if (!context.sessionIdentity) {
    throw new Error('SSH PTY consumer transport identity is unavailable')
  }
  return context.sessionIdentity
}

export class SshPtyConsumerSessionAdapter {
  private readonly session: PtyConsumerSession
  private readonly sourceCredit: SshPtySourceCreditAdapter
  private readonly pausedDeliveryByPty = new Map<string, PtySourceDeliveryIdentity>()

  constructor(
    dispatcher: RelayDispatcher,
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
    dispatcher.onRequest(SSH_PTY_OPEN_CLIENT_METHOD, (params, context) =>
      this.openClient(params, context)
    )
    dispatcher.onClientDetached((clientId) => {
      const grant = this.session.activeGrant(String(clientId))
      if (grant) {
        this.clearPausedForGrant(grant)
      }
      this.session.close(String(clientId))
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

  deliveryMode(clientId: number): 'source-owner' | 'legacy-owner' | 'subscriber' {
    const grant = this.session.activeGrant(String(clientId))
    if (grant?.role !== 'session-owner') {
      return 'subscriber'
    }
    return grant.capabilities?.outputFlowControl ? 'source-owner' : 'legacy-owner'
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
      if (result.ok) {
        admission.commitPublication()
      } else {
        admission.rollbackPublication()
      }
    })
    return admission.grant
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
