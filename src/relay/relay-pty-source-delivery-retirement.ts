import {
  samePtySourceDelivery,
  type PtySourceDeliverySnapshot
} from '../shared/pty-source-credit-contract'
import type { RelayPtyOwnershipTransferSource } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import type { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'

/** In-process only; removal still requires the caller's durable retirement authority. */
export function prepareRelayPtyCoveredSourceRetirement(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  resolver: RelayPtyOwnershipTransferSourceResolver,
  custody: ReturnType<typeof retainRelayPtyCommittedSourceCustody>,
  successorClientId: number,
  successorGeneration: number
) {
  const source = custody.identity
  const assertAuthority = () => {
    custody.assertCurrent()
    if (
      successorGeneration <= source.sourceOwnerGeneration ||
      !resolver.authorizesResumedTransferAtGeneration(
        source.ownerLease,
        successorGeneration,
        successorClientId
      )
    ) {
      throw new Error('pty_source_retirement_successor_unavailable')
    }
  }
  assertAuthority()
  return prepareSourceRetirementTransaction(
    deliveries,
    session,
    resolver,
    source,
    deliveries.get(source.terminalId)?.clientId ?? -1,
    custody.delivery,
    {
      assertAuthority,
      inspect: () => {
        const actual = resolver.inspectSuccessorRetainedDelivery(
          source,
          successorClientId,
          custody.delivery
        )
        return actual &&
          actual.sentEndSu === custody.delivery.sentEndSu &&
          actual.creditedEndSu === custody.delivery.creditedEndSu
          ? actual
          : null
      }
    }
  )
}

export function bindRelayPtySourceDeliveryRetirement(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  resolver: RelayPtyOwnershipTransferSourceResolver
) {
  return (
    source: RelayPtyOwnershipTransferSource,
    clientId?: number,
    expectedDelivery?: PtySourceDeliverySnapshot
  ) =>
    prepareRelayPtySourceDeliveryRetirement(
      deliveries,
      session,
      resolver,
      source,
      clientId ?? deliveries.get(source.terminalId)?.clientId ?? -1,
      expectedDelivery
    )
}

export function bindRelayPtyCoveredSourceRetirement(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  resolver: RelayPtyOwnershipTransferSourceResolver
) {
  return prepareRelayPtyCoveredSourceRetirement.bind(null, deliveries, session, resolver)
}

/** In-process delivery cleanup only; caller must retain durable retirement and destination authority. */
export function prepareRelayPtySourceDeliveryRetirement(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  resolver: RelayPtyOwnershipTransferSourceResolver,
  source: RelayPtyOwnershipTransferSource,
  clientId: number,
  expectedDelivery?: PtySourceDeliverySnapshot
) {
  return prepareSourceRetirementTransaction(
    deliveries,
    session,
    resolver,
    source,
    clientId,
    expectedDelivery
  )
}

function prepareSourceRetirementTransaction(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  resolver: RelayPtyOwnershipTransferSourceResolver,
  source: RelayPtyOwnershipTransferSource,
  clientId: number,
  expectedDelivery?: PtySourceDeliverySnapshot,
  covered?: { assertAuthority: () => void; inspect: () => PtySourceDeliverySnapshot | null }
) {
  covered?.assertAuthority()
  const owner = Object.freeze({ ...source })
  const inspectActive = () =>
    covered ? covered.inspect() : resolver.inspectDrainedDelivery(owner, clientId)
  const inspectClosed = (
    snapshot: PtySourceDeliverySnapshot | null,
    expected: PtySourceDeliverySnapshot
  ) => inspectClosedRetirementDelivery(snapshot, owner, expected, !!covered)
  const record = deliveries.get(owner.terminalId)
  if (!record && expectedDelivery) {
    const captured = inspectClosed(
      session.sourceDeliverySnapshotIfKnown(expectedDelivery),
      expectedDelivery
    )
    if (!captured) {
      throw new Error('pty_source_retirement_closed_ledger_required')
    }
    const assertCurrent = () => {
      covered?.assertAuthority()
      if (
        deliveries.has(owner.terminalId) ||
        !inspectClosed(session.sourceDeliverySnapshotIfKnown(captured), captured)
      ) {
        throw new Error('pty_source_retirement_absence_changed')
      }
    }
    assertCurrent()
    return {
      delivery: captured,
      assertCurrent,
      assertRemoved: assertCurrent,
      remove(assertAuthority: () => void) {
        assertAuthority()
        assertCurrent()
      }
    }
  }
  const active = inspectActive()
  const closed =
    record && expectedDelivery ? session.sourceDeliverySnapshotIfKnown(record.identity) : null
  const recovered = !active && expectedDelivery ? inspectClosed(closed, expectedDelivery) : null
  const captured = active ?? recovered
  if (!record || !captured || record.legacyExitAccepted || record.sendWaiters.size) {
    throw new Error('pty_source_retirement_drained_delivery_required')
  }
  const identity = record.identity
  let cancellationAttempted = !!recovered
  let cancelled = false
  let removed = false
  let running = false
  const assertCurrent = () => {
    covered?.assertAuthority()
    if (
      deliveries.get(owner.terminalId) !== (removed ? undefined : record) ||
      record.identity !== identity ||
      record.clientId !== clientId ||
      !samePtySourceDelivery(identity, captured)
    ) {
      throw new Error('pty_source_retirement_delivery_changed')
    }
    if (removed) {
      if (!inspectClosed(session.sourceDeliverySnapshotIfKnown(identity), captured)) {
        throw new Error('pty_source_retirement_closed_ledger_required')
      }
      return
    }
    const snapshot = session.sourceDeliverySnapshotIfKnown(identity)
    if (
      !snapshot ||
      !samePtySourceDelivery(snapshot, captured) ||
      snapshot.receivedEndSu !== captured.receivedEndSu ||
      snapshot.sentEndSu !== captured.sentEndSu ||
      snapshot.creditedEndSu !== captured.creditedEndSu ||
      snapshot.windowSu !== captured.windowSu ||
      snapshot.exitPublished ||
      snapshot.generationClosed ||
      record.activating ||
      record.rotationPending ||
      record.restoreRequired ||
      record.sealed ||
      record.sending ||
      record.turnScheduled ||
      record.sourceExitState !== 'idle' ||
      record.recoveryEndSu !== null ||
      record.recoveryCompletionPending ||
      record.legacyExitAccepted ||
      record.sendWaiters.size
    ) {
      throw new Error('pty_source_retirement_delivery_changed')
    }
    if (snapshot.state === 'closed' && cancellationAttempted) {
      return
    }
    if (cancelled || !inspectActive()) {
      throw new Error('pty_source_retirement_drained_delivery_required')
    }
  }
  assertCurrent()
  return {
    delivery: Object.freeze({ ...captured }),
    assertCurrent,
    assertRemoved() {
      if (!removed) {
        throw new Error('pty_source_retirement_publication_still_present')
      }
      assertCurrent()
    },
    remove(assertAuthority: () => void): void {
      if (running) {
        throw new Error('pty_source_retirement_busy')
      }
      const assertAuthorized = () => {
        assertAuthority()
        assertCurrent()
      }
      running = true
      try {
        assertAuthorized()
        if (!cancelled) {
          cancellationAttempted = true
          session.cancelDelivery(identity, 'ownership-transfer-source-retired')
          cancelled = true
        }
        assertAuthorized()
        if (!removed) {
          deliveries.delete(owner.terminalId)
          removed = true
        }
        assertAuthorized()
      } finally {
        running = false
      }
    }
  }
}

function inspectClosedRetirementDelivery(
  closed: PtySourceDeliverySnapshot | null,
  owner: RelayPtyOwnershipTransferSource,
  expected: PtySourceDeliverySnapshot,
  covered = false
) {
  if (
    closed?.state !== 'closed' ||
    !samePtySourceDelivery(closed, expected) ||
    closed.id !== owner.terminalId ||
    closed.ptyIncarnation !== owner.incarnationId ||
    closed.ownerGeneration !== owner.sourceOwnerGeneration ||
    expected.state !== 'active' ||
    expected.generationClosed ||
    expected.exitPublished ||
    closed.generationClosed ||
    closed.exitPublished ||
    (!covered &&
      (closed.receivedEndSu !== closed.sentEndSu || closed.sentEndSu !== closed.creditedEndSu)) ||
    closed.receivedEndSu !== expected.receivedEndSu ||
    closed.sentEndSu !== expected.sentEndSu ||
    closed.creditedEndSu !== expected.creditedEndSu ||
    closed.windowSu !== expected.windowSu
  ) {
    return null
  }
  return Object.freeze({ ...closed, state: 'active' as const })
}
