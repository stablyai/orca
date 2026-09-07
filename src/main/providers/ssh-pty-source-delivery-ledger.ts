import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type { SshPtySourceFrame } from './ssh-pty-source-frame'
import {
  acceptsSourceFrame,
  activePredecessor,
  sameReceivingActivation,
  sameRejectedSourceIdentity,
  settleExactSourceDeliveryCancellation,
  settledReceivingActivationLease,
  type PendingSshPtySourceData,
  type RejectedSourceIdentity,
  type SourceDeliveryLeaseState,
  type SourceDeliveryState,
  type SshPtyRecoveryActivationLease,
  type SshPtyRejectedSourceRecovery,
  type SshPtySourceDeliveryLease
} from './ssh-pty-source-delivery-state'

export class SshPtySourceDeliveryLedger {
  private readonly deliveryByPty = new Map<string, SourceDeliveryState>()

  constructor(
    private readonly mux: SshChannelMultiplexer,
    private readonly publishData: (pending: PendingSshPtySourceData) => void
  ) {}

  install(relayPtyId: string, activation: PtySourceReceivingActivation): SshPtySourceDeliveryLease {
    if (!relayPtyId || activation.ptyIncarnation.length === 0) {
      throw new Error('ssh_source_receiving_activation_invalid')
    }
    const previous = this.deliveryByPty.get(relayPtyId)
    if (previous && sameReceivingActivation(previous.activation, activation)) {
      if (previous.lease.phase !== 'committed') {
        throw new Error('ssh_source_receiving_activation_stale')
      }
      return settledReceivingActivationLease()
    }
    if (
      previous &&
      (activation.clientGeneration <= previous.activation.clientGeneration ||
        activation.ownerGeneration <= previous.activation.ownerGeneration ||
        activation.deliveryToken === previous.activation.deliveryToken)
    ) {
      throw new Error('ssh_source_receiving_activation_stale')
    }
    return this.installProvisional(relayPtyId, activation, previous)
  }

  admit(pending: PendingSshPtySourceData & { source: SshPtySourceFrame }): boolean {
    const current = this.deliveryByPty.get(pending.relayPtyId)
    if (!acceptsSourceFrame(current, pending.params, pending.source)) {
      return false
    }
    const accepted = Object.freeze({
      ...current,
      sourceEndSu: pending.source.sourceEndSu
    }) as SourceDeliveryState
    this.deliveryByPty.set(pending.relayPtyId, accepted)
    if (accepted.lease.phase === 'recovery') {
      accepted.lease.recoverySink?.(pending)
    } else if (accepted.lease.phase !== 'committed') {
      accepted.lease.pendingData.push(pending)
    } else {
      this.publishData(pending)
    }
    return true
  }

  recordExit(relayPtyId: string): void {
    const current = this.deliveryByPty.get(relayPtyId)
    if (current?.lease.phase === 'committed') {
      this.deliveryByPty.delete(relayPtyId)
    } else if (current) {
      current.lease.exited = true
    }
  }

  async reject(
    relayPtyId: string,
    identity: RejectedSourceIdentity | undefined
  ): Promise<SshPtyRejectedSourceRecovery> {
    if (!identity) {
      return 'reconnect-channel'
    }
    const offeredCurrent = this.deliveryByPty.get(relayPtyId)
    const matched = Boolean(
      offeredCurrent && sameRejectedSourceIdentity(offeredCurrent.activation, identity)
    )
    const canceled = await settleExactSourceDeliveryCancellation(this.mux, relayPtyId, identity)
    if (matched && canceled) {
      const current = this.deliveryByPty.get(relayPtyId)
      if (current && sameRejectedSourceIdentity(current.activation, identity)) {
        this.retire(relayPtyId, current.previous, current.lease)
        return 'fresh-activation'
      }
      return current ? 'reconnect-channel' : 'fresh-activation'
    }
    if (!matched && !canceled) {
      return 'confirm-existing'
    }
    return 'reconnect-channel'
  }

  private installProvisional(
    relayPtyId: string,
    activation: PtySourceReceivingActivation,
    previous: SourceDeliveryState | undefined
  ): SshPtySourceDeliveryLease {
    const leaseState: SourceDeliveryLeaseState = {
      phase: 'provisional',
      pendingData: [],
      exited: false
    }
    this.deliveryByPty.set(
      relayPtyId,
      Object.freeze({
        activation,
        sourceEndSu: activation.checkpointSourceEndSu,
        lease: leaseState,
        ...(previous ? { previous } : {})
      })
    )
    let settled = false
    let transferInProgress = false
    let rollbackSettlement: Promise<boolean> | undefined
    return Object.freeze({
      commit: () => {
        if (settled || transferInProgress) {
          return
        }
        settled = true
        this.commit(relayPtyId, leaseState)
      },
      rollback: () => {
        if (rollbackSettlement) {
          return rollbackSettlement
        }
        if (settled || transferInProgress) {
          return Promise.resolve(false)
        }
        settled = true
        this.retire(relayPtyId, previous, leaseState)
        rollbackSettlement = settleExactSourceDeliveryCancellation(this.mux, relayPtyId, activation)
        return rollbackSettlement
      },
      transferToRecovery: (sink) => {
        if (settled || transferInProgress || leaseState.phase !== 'provisional') {
          throw new Error('ssh_source_receiving_activation_stale')
        }
        transferInProgress = true
        try {
          const recoveryLease = this.transferToRecovery(relayPtyId, leaseState, previous, sink)
          settled = true
          return recoveryLease
        } finally {
          transferInProgress = false
        }
      }
    })
  }

  private transferToRecovery(
    relayPtyId: string,
    lease: SourceDeliveryLeaseState,
    previous: SourceDeliveryState | undefined,
    sink: (pending: PendingSshPtySourceData) => void
  ): SshPtyRecoveryActivationLease {
    if (this.deliveryByPty.get(relayPtyId)?.lease !== lease) {
      this.retire(relayPtyId, previous, lease)
      throw new Error('ssh_source_receiving_activation_stale')
    }
    lease.phase = 'recovery'
    lease.recoverySink = sink
    try {
      while (lease.pendingData.length > 0) {
        sink(lease.pendingData.shift()!)
      }
    } catch (error) {
      this.retire(relayPtyId, previous, lease)
      throw error
    }
    let settled = false
    return Object.freeze({
      commit: () => {
        if (settled) {
          return
        }
        settled = true
        lease.recoverySink = undefined
        this.commit(relayPtyId, lease)
      },
      retire: () => {
        if (settled) {
          return
        }
        settled = true
        lease.recoverySink = undefined
        this.retire(relayPtyId, previous, lease)
      }
    })
  }

  private commit(relayPtyId: string, lease: SourceDeliveryLeaseState): void {
    if (this.deliveryByPty.get(relayPtyId)?.lease !== lease) {
      lease.phase = 'retired'
      lease.pendingData.splice(0)
      return
    }
    lease.phase = 'committing'
    while (lease.pendingData.length > 0) {
      this.publishData(lease.pendingData.shift()!)
    }
    lease.phase = 'committed'
    const current = this.deliveryByPty.get(relayPtyId)
    if (lease.exited && current?.lease === lease) {
      this.deliveryByPty.delete(relayPtyId)
      return
    }
    if (current?.lease === lease && current.previous) {
      this.deliveryByPty.set(
        relayPtyId,
        Object.freeze({
          activation: current.activation,
          sourceEndSu: current.sourceEndSu,
          lease: current.lease
        })
      )
    }
  }

  private retire(
    relayPtyId: string,
    previous: SourceDeliveryState | undefined,
    lease: SourceDeliveryLeaseState
  ): void {
    lease.phase = 'retired'
    lease.recoverySink = undefined
    lease.pendingData.splice(0)
    if (this.deliveryByPty.get(relayPtyId)?.lease !== lease) {
      return
    }
    if (lease.exited) {
      this.deliveryByPty.delete(relayPtyId)
      return
    }
    const predecessor = activePredecessor(previous)
    if (predecessor) {
      this.deliveryByPty.set(relayPtyId, predecessor)
    } else {
      this.deliveryByPty.delete(relayPtyId)
    }
  }
}
