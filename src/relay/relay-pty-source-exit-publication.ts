import type { RelayDispatcher } from './dispatcher'
import { legacyProjectionRole } from './relay-pty-source-output'
import {
  onceSinkSettlement,
  type RelayPtySourceDeliveryRecord,
  type RelayPtySourcePublicationCounters,
  type RelayPtySourceSendScheduler
} from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type PtyExitParams = { id: string; code: number; incarnationId: string }

type PtySourceExitOptions = {
  params: PtyExitParams
  record: RelayPtySourceDeliveryRecord
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
  legacyExits?: RelayPtySourceLegacyExitIndex
  dispatcher: RelayDispatcher
  session: SshPtyConsumerSessionAdapter
  sender: RelayPtySourceSendScheduler
  counters: RelayPtySourcePublicationCounters
  onCapacity: (id: string) => void
}

/**
 * Remembers which exits already reached the legacy subscribers. `legacyExitAccepted` dies with
 * the delivery record, but a cancel or grace expiry can retire the record between the legacy
 * projection and the owner's exit frame, and the fallback must not broadcast a second copy.
 */
export class RelayPtySourceLegacyExitIndex {
  private readonly stateByPty = new Map<
    string,
    Readonly<{ incarnationId: string; state: 'owner-pending' | 'complete' }>
  >()

  remember(params: PtyExitParams, delivered: boolean): void {
    if (delivered) {
      this.stateByPty.set(params.id, {
        incarnationId: params.incarnationId,
        state: 'owner-pending'
      })
    } else {
      this.forget(params.id)
    }
  }

  complete(params: PtyExitParams): void {
    if (this.stateByPty.get(params.id)?.incarnationId !== params.incarnationId) {
      return
    }
    this.stateByPty.set(params.id, { incarnationId: params.incarnationId, state: 'complete' })
  }

  /** Drops the entry once the exit is complete for every client, so the map cannot grow unbounded. */
  forget(id: string): void {
    this.stateByPty.delete(id)
  }

  clear = (): void => this.stateByPty.clear()

  /** Publishes a retired record's exit to the owner alone, or null when nothing was projected. */
  publishAfterRetire(
    params: PtyExitParams,
    dispatcher: RelayDispatcher,
    session: SshPtyConsumerSessionAdapter
  ): boolean | null {
    const remembered = this.stateByPty.get(params.id)
    if (remembered?.incarnationId !== params.incarnationId) {
      return null
    }
    if (remembered.state === 'complete') {
      this.forget(params.id)
      return true
    }
    const published = dispatcher.tryNotifyPtyExitToMatchingClients(
      (clientId) => session.deliveryMode(clientId) === 'source-owner',
      params
    )
    if (published) {
      this.forget(params.id)
    }
    return published
  }
}

function logExitSettlementFault(id: string, err: unknown): void {
  process.stderr.write(
    `[pty-source-exit] exit settlement failed for ${id}: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`
  )
}

function retireFaultedPtySourceExit(
  options: PtySourceExitOptions,
  record: RelayPtySourceDeliveryRecord
): void {
  try {
    options.session.cancelDelivery(record.identity, 'exit-publication-failed')
  } catch (err) {
    logExitSettlementFault(options.params.id, err)
  }
  try {
    options.sender.wakeSendWaiters(record)
  } catch (err) {
    logExitSettlementFault(options.params.id, err)
  } finally {
    record.sendWaiters.clear()
  }
  if (options.deliveries.get(options.params.id) === record) {
    options.deliveries.delete(options.params.id)
  }
}

/** Seals and publishes the pty's exit, recording whether the legacy projection outlives the record. */
export function sealAndPublishTrackedPtySourceExit(
  options: Omit<PtySourceExitOptions, 'record'> & { legacyExits: RelayPtySourceLegacyExitIndex }
): boolean {
  const record = options.deliveries.get(options.params.id)
  if (!record) {
    return false
  }
  try {
    return sealAndPublishPtySourceExit({ ...options, record })
  } catch (err) {
    retireFaultedPtySourceExit({ ...options, record }, record)
    throw err
  }
}

export function sealAndPublishPtySourceExit(options: PtySourceExitOptions): boolean {
  const { params, record, deliveries, dispatcher, session, sender, counters, onCapacity } = options
  if (record.restoreRequired) {
    const published = dispatcher.tryNotifyPtyExit(params)
    if (published && deliveries.get(params.id) === record) {
      deliveries.delete(params.id)
      options.legacyExits?.forget(params.id)
    }
    return published
  }
  if (record.sourceExitState === 'pending') {
    // Why: an exit frame is in flight; its settlement drives the next step.
    return false
  }
  const probe = session.sourceDeliverySnapshotIfKnown(record.identity)
  // Why: 'closing' is defensive — the ledger closes a canceled record in the same call, so it
  // only ever hands back 'closed' (or null once the tombstone is evicted).
  if (!probe || probe.state === 'closed' || probe.state === 'closing') {
    if (probe?.exitPublished === true || record.sourceExitState === 'published') {
      // Why: the delivery completed healthily — the owner already has the credit-mode exit.
      if (deliveries.get(params.id) === record) {
        deliveries.delete(params.id)
      }
      options.legacyExits?.forget(params.id)
      return true
    }
    // Why: the delivery was canceled out from under the record; never touch the sealed
    // ledger — the exit flows as a legacy broadcast instead.
    const published = record.legacyExitAccepted
      ? dispatcher.tryNotifyPtyExitToMatchingClients(
          (clientId) => session.deliveryMode(clientId) === 'source-owner',
          params
        )
      : dispatcher.tryNotifyPtyExit(params)
    if (published && deliveries.get(params.id) === record) {
      deliveries.delete(params.id)
      options.legacyExits?.forget(params.id)
    }
    return published
  }
  if (!record.sealed) {
    session.sealDelivery(record.identity)
    record.sealed = true
  }
  sender.pump(record)
  const snapshot = session.sourceDeliverySnapshot(record.identity)
  if (snapshot.sentEndSu !== snapshot.receivedEndSu) {
    return false
  }
  if (!record.legacyExitAccepted) {
    record.legacyExitAccepted = dispatcher.projectPtyExitToLegacyClients(
      (clientId) => legacyProjectionRole(session, clientId),
      params
    )
    options.legacyExits?.remember(params, record.legacyExitAccepted)
    if (!record.legacyExitAccepted) {
      return false
    }
  }
  if (record.sourceExitState !== 'idle') {
    return true
  }
  record.sourceExitState = 'pending'
  const settle = onceSinkSettlement((result) => {
    if (result.ok) {
      record.sourceExitState = 'published'
      counters.exitCommitted++
    } else {
      record.sourceExitState = 'idle'
      counters.exitRolledBack++
    }
    let deliveryGone = false
    let settlementFailed = false
    try {
      // Why: a client cancel or rotation can close the delivery while this frame is in
      // flight; settling a closed ledger entry throws out of a bare socket write/drain
      // callback (dispatcher-client-writer releaseEntry) straight into uncaughtException.
      deliveryGone =
        session.sourceDeliverySnapshotIfKnown(record.identity)?.state !== 'sealed-unsettled'
      if (!deliveryGone) {
        session.settleExitPublication(record.identity, result)
      }
    } catch (err) {
      settlementFailed = true
      logExitSettlementFault(params.id, err)
      if (result.ok) {
        options.legacyExits?.complete(params)
      }
      retireFaultedPtySourceExit(options, record)
    } finally {
      if (result.ok || deliveryGone || settlementFailed) {
        try {
          // Why: capacity fans out into arbitrary handler code, still from the bare socket callback.
          onCapacity(params.id)
        } catch (err) {
          logExitSettlementFault(params.id, err)
        }
      }
    }
  })
  const accepted = dispatcher.tryNotifyPtyExitToClient(record.clientId, params, settle)
  if (!accepted && record.sourceExitState === 'pending') {
    record.sourceExitState = 'idle'
  }
  return accepted
}
