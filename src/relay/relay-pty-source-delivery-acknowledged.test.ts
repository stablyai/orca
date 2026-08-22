import { describe, expect, it } from 'vitest'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import { RelayPtySourceCreditLedger } from './pty-source-credit-ledger'
import { ptySourceDeliveryFullyAcknowledged } from './relay-pty-source-output'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const IDENTITY: PtySourceDeliveryIdentity = {
  id: 'pty-1',
  providerGeneration: 1,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-1',
  deliveryToken: 'token-1'
}

// Why the REAL ledger and not a snapshot literal: the whole point of the predicate is which of the
// three frontiers it reads, and only the ledger's own send/ack machinery moves them apart.
function ledgerSession(ledger: RelayPtySourceCreditLedger): SshPtyConsumerSessionAdapter {
  return {
    sourceDeliverySnapshotIfKnown: (identity: PtySourceDeliveryIdentity) =>
      ledger.snapshotIfKnown(identity)
  } as unknown as SshPtyConsumerSessionAdapter
}

function append(ledger: RelayPtySourceCreditLedger, data: string): void {
  const start = ledger.snapshot(IDENTITY).receivedEndSu
  ledger.append(IDENTITY, {
    spanId: `span-${start}`,
    data,
    displayStart: start,
    displayEnd: start + data.length,
    splittable: true,
    transform: { transformed: false, rawLengthSu: data.length, scalarSafe: true }
  })
}

const record = { identity: IDENTITY, restoreRequired: false, rotationPending: false }

describe('ptySourceDeliveryFullyAcknowledged', () => {
  it('refuses a delivery whose committed send was never acknowledged', () => {
    // The outage itself: commitSend fires on SINK settlement, so these bytes went into a socket
    // that may already be dying. They are never resent (reserveNextSend resumes from sentEndSu), so
    // the consumer's model is short by an amount the relay cannot name.
    const ledger = new RelayPtySourceCreditLedger()
    ledger.open(IDENTITY, 1024)
    append(ledger, 'lost in the socket')
    ledger.commitSend(ledger.reserveNextSend(IDENTITY)!)

    const snapshot = ledger.snapshot(IDENTITY)
    expect(snapshot.sentEndSu).toBe(snapshot.receivedEndSu)
    expect(snapshot.creditedEndSu).toBe(0)
    expect(ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), record)).toBe(false)
  })

  it('accepts only once the consumer has credited everything the delivery received', () => {
    const ledger = new RelayPtySourceCreditLedger()
    ledger.open(IDENTITY, 1024)
    append(ledger, 'delivered')
    ledger.commitSend(ledger.reserveNextSend(IDENTITY)!)
    ledger.acknowledge(IDENTITY, {
      id: IDENTITY.id,
      clientGeneration: IDENTITY.clientGeneration,
      ownerGeneration: IDENTITY.ownerGeneration,
      deliveryToken: IDENTITY.deliveryToken,
      creditedEndSu: 'delivered'.length
    })

    expect(ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), record)).toBe(true)

    // Fresh source that has not even been reserved yet is equally unproven.
    append(ledger, ' and more')
    expect(ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), record)).toBe(false)
  })

  it('refuses an unknown, restoring or rotating delivery', () => {
    const ledger = new RelayPtySourceCreditLedger()
    expect(ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), record)).toBe(false)

    ledger.open(IDENTITY, 1024)
    expect(
      ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), {
        ...record,
        restoreRequired: true
      })
    ).toBe(false)
    expect(
      ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), {
        ...record,
        rotationPending: true
      })
    ).toBe(false)
    expect(ptySourceDeliveryFullyAcknowledged(ledgerSession(ledger), undefined)).toBe(false)
  })
})
