import { describe, expect, it } from 'vitest'
import type { PtySourceSpan } from '../../shared/pty-source-credit-contract'
import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-output-source-obligations'
import {
  MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS,
  SshPtyOwnershipTransferPendingSettlements
} from './ssh-pty-ownership-transfer-pending-settlements'

function range(
  index = 1,
  overrides: Partial<SshPtyOwnershipTransferSourceRange> = {}
): SshPtyOwnershipTransferSourceRange {
  const deliveryToken = `token-${index}`
  return {
    providerGeneration: 1,
    relayPtyId: 'pty-1',
    spanId: `${deliveryToken}:0:4`,
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken,
    ptyIncarnation: 'incarnation-1',
    sourceStartSu: 0,
    sourceEndSu: 4,
    ownershipTransfer: {
      bridgeId: `bridge-${index}`,
      terminalId: 'pty-1',
      incarnationId: 'incarnation-1',
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 3,
      destinationRuntimeId: 'runtime-1',
      version: 1,
      frameSeq: index,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4
    },
    ...overrides
  }
}

function span(value: SshPtyOwnershipTransferSourceRange): PtySourceSpan {
  return {
    id: value.relayPtyId,
    providerGeneration: value.providerGeneration,
    clientGeneration: value.clientGeneration,
    ownerGeneration: value.ownerGeneration,
    ptyIncarnation: value.ptyIncarnation,
    deliveryToken: value.deliveryToken,
    spanId: value.spanId,
    sourceStartSu: value.sourceStartSu,
    sourceEndSu: value.sourceEndSu,
    displayStart: 0,
    displayEnd: 4,
    data: 'data',
    ownershipTransfer: value.ownershipTransfer,
    transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
  }
}

describe('SshPtyOwnershipTransferPendingSettlements', () => {
  it('retains a destination receipt until the exact source span is admitted', () => {
    const pending = new SshPtyOwnershipTransferPendingSettlements()
    const receipt = range()
    pending.retain(receipt)

    expect(pending.take({ ...span(receipt), providerGeneration: 2 })).toBeNull()
    expect(pending.size).toBe(1)
    expect(pending.take(span(receipt))).toBe(receipt)
    expect(pending.size).toBe(0)
  })

  it('deduplicates an identical receipt and rejects a conflicting identity', () => {
    const pending = new SshPtyOwnershipTransferPendingSettlements()
    const receipt = range()
    pending.retain(receipt)
    pending.retain({ ...receipt })

    expect(pending.size).toBe(1)
    expect(() => pending.retain({ ...receipt, sourceEndSu: 3 })).toThrow('conflict')
    expect(pending.size).toBe(1)
  })

  it('clears only receipts owned by the closed provider generation', () => {
    const pending = new SshPtyOwnershipTransferPendingSettlements()
    pending.retain(range(1))
    pending.retain(range(2, { providerGeneration: 2 }))

    pending.closeGeneration(1)

    expect(pending.size).toBe(1)
    expect(pending.take(span(range(2, { providerGeneration: 2 })))).not.toBeNull()
  })

  it('fails closed instead of retaining an unbounded destination backlog', () => {
    const pending = new SshPtyOwnershipTransferPendingSettlements()
    for (let index = 1; index <= MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS; index += 1) {
      pending.retain(range(index))
    }

    expect(() =>
      pending.retain(range(MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS + 1))
    ).toThrow('capacity')
    expect(pending.size).toBe(MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS)
  })
})
