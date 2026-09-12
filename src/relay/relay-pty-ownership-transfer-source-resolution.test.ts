import { describe, expect, it } from 'vitest'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'

function resolverWithOwners(
  owners: ReadonlyMap<number, Readonly<{ ownerGeneration: number; ownerLease: string }>>
) {
  const session = {
    activeSessionOwner: (clientId: number) => owners.get(clientId) ?? null
  } as unknown as SshPtyConsumerSessionAdapter
  return new RelayPtyOwnershipTransferSourceResolver(new Map(), session)
}

describe('RelayPtyOwnershipTransferSourceResolver resumed abort authorization', () => {
  it('distinguishes the old generation from a newer generation of the same owner lease', () => {
    const resolver = resolverWithOwners(
      new Map([
        [1, { ownerGeneration: 4, ownerLease: 'lease-1' }],
        [2, { ownerGeneration: 5, ownerLease: 'lease-1' }]
      ])
    )

    expect(resolver.authorizesResumedTransfer('lease-1', 4, 1)).toBe(false)
    expect(resolver.authorizesResumedTransfer('lease-1', 4, 2)).toBe(true)
  })

  it('rejects a different owner lease and a non-owner client', () => {
    const resolver = resolverWithOwners(
      new Map([[2, { ownerGeneration: 5, ownerLease: 'lease-2' }]])
    )

    expect(resolver.authorizesResumedTransfer('lease-1', 4, 2)).toBe(false)
    expect(resolver.authorizesResumedTransfer('lease-1', 4, 3)).toBe(false)
    expect(resolver.authorizesResumedTransfer('lease-2', -1, 2)).toBe(false)
  })
})
