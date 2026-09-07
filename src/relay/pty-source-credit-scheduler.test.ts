import { describe, expect, it, vi } from 'vitest'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import { RelayPtySourceCreditLedger } from './pty-source-credit-ledger'
import { RelayPtySourceCreditScheduler } from './pty-source-credit-scheduler'

function identity(index: number): PtySourceDeliveryIdentity {
  return {
    id: `pty-${index}`,
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: `incarnation-${index}`,
    deliveryToken: `token-${index}`
  }
}

describe('RelayPtySourceCreditScheduler', () => {
  it('round-robins fifty continuously active PTYs without exceeding turn budgets', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const scheduler = new RelayPtySourceCreditScheduler(ledger)
    const identities = Array.from({ length: 50 }, (_, index) => identity(index))
    for (const owner of identities) {
      ledger.open(owner, 1024)
      ledger.append(owner, {
        spanId: `span-${owner.id}`,
        data: 'x'.repeat(100),
        displayStart: 0,
        displayEnd: 100,
        splittable: true,
        transform: { transformed: false, rawLengthSu: 100, scalarSafe: true }
      })
      scheduler.enqueue(owner)
    }

    const visited: string[] = []
    for (let turn = 0; turn < 25; turn++) {
      const reservations = scheduler.takeTurn()
      expect(reservations.length).toBeLessThanOrEqual(2)
      expect(
        reservations.reduce(
          (total, reservation) =>
            total + reservation.span.sourceEndSu - reservation.span.sourceStartSu,
          0
        )
      ).toBeLessThanOrEqual(32 * 1024)
      for (const reservation of reservations) {
        visited.push(reservation.identity.id)
        ledger.commitSend(reservation)
      }
    }

    expect(new Set(visited)).toEqual(new Set(identities.map((owner) => owner.id)))
  })

  it('does not duplicate a turn after remove and re-enqueue', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const scheduler = new RelayPtySourceCreditScheduler(ledger)
    const owner = identity(1)
    ledger.open(owner, 8)
    ledger.append(owner, {
      spanId: 'span-1',
      data: 'ab',
      displayStart: 0,
      displayEnd: 2,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 2, scalarSafe: true }
    })
    scheduler.enqueue(owner)
    scheduler.remove(owner)
    scheduler.enqueue(owner)

    expect(scheduler.takeTurn(2, 2)).toHaveLength(1)
  })

  it('isolates one rejecting delivery without losing reservations or blocking peers', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const scheduler = new RelayPtySourceCreditScheduler(ledger)
    const owners = [identity(1), identity(2), identity(3)]
    for (const owner of owners) {
      ledger.open(owner, 8)
      ledger.append(owner, {
        spanId: `span-${owner.id}`,
        data: 'ab',
        displayStart: 0,
        displayEnd: 2,
        splittable: true,
        transform: { transformed: false, rawLengthSu: 2, scalarSafe: true }
      })
      scheduler.enqueue(owner)
    }
    const reserveNextSend = ledger.reserveNextSend.bind(ledger)
    const reserve = vi.spyOn(ledger, 'reserveNextSend').mockImplementation((owner, maxSourceSu) => {
      if (owner === owners[1]) {
        throw new Error('delivery ledger corrupted')
      }
      return reserveNextSend(owner, maxSourceSu)
    })

    const reservations = scheduler.takeTurn(2, 4)

    expect(reserve).toHaveBeenCalledTimes(3)
    expect(reservations.map(({ identity: owner }) => owner.id)).toEqual(['pty-1', 'pty-3'])
    for (const reservation of reservations) {
      ledger.commitSend(reservation)
    }
    scheduler.takeTurn(2, 4)
    expect(reserve).toHaveBeenCalledTimes(5)
    expect(reserve.mock.calls.map(([owner]) => owner.id)).toEqual([
      'pty-1',
      'pty-2',
      'pty-3',
      'pty-1',
      'pty-3'
    ])
  })
})
