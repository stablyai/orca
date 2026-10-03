import type { RequestContext } from './dispatcher'
import { randomUUID } from 'node:crypto'
import type { RelayGraceLifecycle } from './relay-grace-lifecycle'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest,
  type RelayOwnerResetAcknowledgment
} from '../shared/relay-owner-reset-contract'

type ResetOptions = {
  runtimeIncarnation?: string
  owners: Pick<SshPtyConsumerSessionAdapter, 'activeSessionOwner' | 'assertOwnerPublicationSettled'>
  lifecycle: Pick<RelayGraceLifecycle, 'prepareShutdown' | 'finishShutdown'>
  ownsEndpoint: () => boolean
  persistPrepared?: (
    request: RelayOwnerResetRequest,
    principal: string,
    authenticationKind: string,
    assertAuthority: () => void
  ) => undefined
}

/** Prepared continuation never authorizes new cleanup or ownership admission. */
export class RelayOwnerReset {
  readonly runtimeIncarnation: string
  private finished = false
  private admitted: {
    request: RelayOwnerResetRequest
    principal: string
    authenticationKind: string
    clientId: number
    transportGeneration: number | undefined
    state: 'pending' | 'prepared' | 'failed'
  } | null = null

  constructor(private readonly options: ResetOptions) {
    this.runtimeIncarnation = options.runtimeIncarnation ?? randomUUID()
  }

  recoverPrepared(
    params: Record<string, unknown>,
    context: RequestContext
  ): RelayOwnerResetAcknowledgment {
    const request = parseRelayOwnerResetRequest(params)
    const expectedIncarnation = request.runtimeIncarnation
    const retained = this.admitted
    const clientId = context.clientId
    const generation = context.transportGeneration
    const assertContinuation = (): void => {
      const identity = context.sessionIdentity
      if (
        !retained ||
        this.admitted !== retained ||
        retained.state !== 'prepared' ||
        expectedIncarnation !== this.runtimeIncarnation ||
        request.operationId !== retained.request.operationId ||
        request.ownerGeneration !== retained.request.ownerGeneration ||
        request.ownerLease !== retained.request.ownerLease ||
        identity?.authenticated !== true ||
        identity.allowSessionOwner !== true ||
        identity.principal !== retained.principal ||
        identity.authenticationKind !== retained.authenticationKind ||
        context.isStale() ||
        context.signal?.aborted ||
        context.clientId !== clientId ||
        context.transportGeneration !== generation ||
        !context.onResponseSettled ||
        !this.options.ownsEndpoint()
      ) {
        throw new Error('relay_reset_continuation_unauthorized')
      }
    }
    assertContinuation()
    const persisted = this.options.persistPrepared?.(
      request,
      retained!.principal,
      retained!.authenticationKind,
      assertContinuation
    )
    if (persisted !== undefined) {
      throw new Error('relay_reset_preparation_journal_not_synchronous')
    }
    assertContinuation()
    context.onResponseSettled!((settlement) => {
      if (!settlement.ok || this.finished) {
        return
      }
      assertContinuation()
      this.finish()
    })
    assertContinuation()
    return {
      version: 1,
      operationId: request.operationId,
      runtimeIncarnation: this.runtimeIncarnation,
      prepared: true
    }
  }

  private finish(): void {
    this.finished = true
    try {
      this.options.lifecycle.finishShutdown()
    } catch (error) {
      this.finished = false
      throw error
    }
  }

  async prepare(
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<RelayOwnerResetAcknowledgment> {
    const request = parseRelayOwnerResetRequest(params)
    if (request.runtimeIncarnation !== this.runtimeIncarnation) {
      throw new Error('relay_reset_incarnation_mismatch')
    }
    const principal = context.sessionIdentity?.principal
    const authenticationKind = context.sessionIdentity?.authenticationKind
    const clientId = context.clientId
    const transportGeneration = context.transportGeneration
    const assertOwner = (): void => {
      const identity = context.sessionIdentity
      const owner = this.options.owners.activeSessionOwner(context.clientId)
      if (
        context.isStale() ||
        context.signal?.aborted ||
        identity?.authenticated !== true ||
        identity.allowSessionOwner !== true ||
        !['launch-nonce', 'endpoint-credential'].includes(identity.authenticationKind) ||
        !principal ||
        identity.principal !== principal ||
        identity.authenticationKind !== authenticationKind ||
        context.clientId !== clientId ||
        context.transportGeneration !== transportGeneration ||
        !context.onResponseSettled ||
        !this.options.ownsEndpoint() ||
        owner?.ownerGeneration !== request.ownerGeneration ||
        owner.ownerLease !== request.ownerLease
      ) {
        throw new Error('relay_reset_unauthorized')
      }
    }
    assertOwner()
    const previous = this.admitted
    if (previous) {
      if (
        previous.request.operationId !== request.operationId ||
        previous.request.ownerGeneration !== request.ownerGeneration ||
        previous.request.ownerLease !== request.ownerLease ||
        previous.principal !== principal ||
        previous.authenticationKind !== context.sessionIdentity!.authenticationKind ||
        previous.clientId !== context.clientId ||
        previous.transportGeneration !== context.transportGeneration
      ) {
        throw new Error('relay_reset_operation_conflict')
      }
      if (previous.state === 'pending') {
        throw new Error('relay_reset_preparation_in_progress')
      }
    }
    let prepared = false
    let preparationRecord: typeof this.admitted = null
    context.onResponseSettled!((settlement) => {
      if (
        !prepared ||
        !settlement.ok ||
        this.finished ||
        !preparationRecord ||
        this.admitted !== preparationRecord ||
        preparationRecord.state !== 'prepared'
      ) {
        return
      }
      assertOwner()
      this.finish()
    })
    assertOwner()
    this.options.owners.assertOwnerPublicationSettled()
    if (previous?.state !== 'prepared') {
      const admitted = previous ?? {
        request,
        principal: principal!,
        authenticationKind: context.sessionIdentity!.authenticationKind,
        clientId: context.clientId,
        transportGeneration: context.transportGeneration,
        state: 'pending' as const
      }
      this.admitted = admitted
      admitted.state = 'pending'
      let began = false
      try {
        await this.options.lifecycle.prepareShutdown(context, () => {
          began = true
        })
        admitted.state = 'prepared'
      } catch (error) {
        if (!began && !previous && this.admitted === admitted) {
          this.admitted = null
        } else {
          admitted.state = 'failed'
        }
        throw error
      }
    }
    assertOwner()
    if (
      this.options.persistPrepared?.(request, principal!, authenticationKind!, assertOwner) !==
      undefined
    ) {
      throw new Error('relay_reset_preparation_journal_not_synchronous')
    }
    assertOwner()
    preparationRecord = this.admitted
    prepared = true
    return {
      version: 1,
      operationId: request.operationId,
      runtimeIncarnation: this.runtimeIncarnation,
      prepared: true
    }
  }
}
