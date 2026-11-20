import { describe, expect, it } from 'vitest'
import { typedByOf } from './rpc-caller-typed-by'

const hostSignedInAs = (account: string | null) => () => ({ signedInAccount: () => account })

describe('where a message was typed', () => {
  it('keeps the account a paired device claims when it sends, whoever signs in there later', () => {
    let claim: { id: string; name: string } | null = { id: 'acct-alice', name: 'Alice' }
    const context = {
      caller: { kind: 'paired-device' as const, deviceId: 'laptop-1' },
      runtime: { pairedDeviceAccount: () => claim }
    }
    const sent = typedByOf(context)
    claim = { id: 'acct-bob', name: 'Bob' }
    expect(sent).toEqual({
      by: 'device',
      deviceId: 'laptop-1',
      account: 'Alice',
      accountId: 'acct-alice'
    })
    claim = null
    expect(typedByOf(context)).toEqual({ by: 'device', deviceId: 'laptop-1' })
  })

  it("marks own vs another person's by account id at send, and nothing when the host has no account", () => {
    const sam = { id: 'acct-sam', name: 'Sam Lee', computer: "Sam's MacBook Pro" }
    const context = (host: string | null) => ({
      caller: { kind: 'paired-device' as const, deviceId: 'shared-row' },
      clientKind: 'runtime' as const,
      deviceSelf: { orcaAccount: () => sam },
      runtime: { pairedDeviceAccount: () => sam, getConnectorCloud: hostSignedInAs(host) }
    })
    expect(typedByOf(context('acct-owner'))).toMatchObject({
      own: false,
      computer: "Sam's MacBook Pro"
    })
    expect(typedByOf(context('acct-sam'))).toMatchObject({ own: true })
    expect(typedByOf(context(null))).not.toHaveProperty('own')
  })

  it("names a desktop by its own connection's claim, not the shared row's", () => {
    const seen: unknown[] = []
    typedByOf({
      caller: { kind: 'paired-device', deviceId: 'shared-row' },
      clientKind: 'runtime',
      deviceSelf: { orcaAccount: () => null },
      runtime: {
        pairedDeviceAccount: (_id, claim) => {
          seen.push(claim)
          return null
        }
      }
    })
    typedByOf({
      caller: { kind: 'paired-device', deviceId: 'phone' },
      clientKind: 'mobile',
      runtime: {
        pairedDeviceAccount: (_id, claim) => {
          seen.push(claim)
          return null
        }
      }
    })
    expect(seen).toEqual([null, undefined])
  })
})
