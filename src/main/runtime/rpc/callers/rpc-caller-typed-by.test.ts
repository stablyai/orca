import { describe, expect, it } from 'vitest'
import { typedByOf } from './rpc-caller-typed-by'

const runtime = (claim: { id: string; name: string } | null) => ({
  pairedDeviceAccount: () => claim,
  getConnectorCloud: () => ({ signedInAccount: () => 'acct-owner' })
})

describe('where a message was typed', () => {
  it('keeps the device an agent’s CLI used its pairing from, and whether it is the owner’s', () => {
    const caller = { kind: 'paired-device', deviceId: 'd1', agent: true } as const
    expect(typedByOf({ caller, runtime: runtime(null) })).toEqual({ by: 'agent', deviceId: 'd1' })
    expect(typedByOf({ caller, runtime: runtime({ id: 'acct-sam', name: 'Sam' }) })).toEqual({
      by: 'agent',
      deviceId: 'd1',
      own: false
    })
    expect(typedByOf({ caller, runtime: runtime({ id: 'acct-owner', name: 'Me' }) })).toEqual({
      by: 'agent',
      deviceId: 'd1',
      own: true
    })
  })

  it('names no device for an agent on this host', () => {
    expect(typedByOf({ caller: { kind: 'local-cli' }, runtime: runtime(null) })).toEqual({
      by: 'agent'
    })
  })
})
