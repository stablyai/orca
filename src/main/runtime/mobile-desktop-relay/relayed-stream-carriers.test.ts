import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../rpc/methods'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { MOBILE_RPC_METHOD_ROUTES } from '../runtime-rpc/runtime-rpc-mobile-method-routing'
import { RELAYED_STREAM_CARRIERS } from './relayed-stream-carriers'

describe('relayed stream carrier census', () => {
  const relayableStreams: string[] = ALL_RPC_METHODS.filter(
    (method) =>
      'stream' in method &&
      MOBILE_RPC_METHOD_ALLOWLIST.has(method.name) &&
      MOBILE_RPC_METHOD_ROUTES.get(method.name) === 'execution-host'
  ).map((method) => method.name)

  it('classifies how every relayable stream names itself', () => {
    expect(relayableStreams.filter((name) => !RELAYED_STREAM_CARRIERS.has(name))).toEqual([])
  })

  it('classifies nothing that is not a relayable stream', () => {
    expect(
      [...RELAYED_STREAM_CARRIERS.keys()].filter((name) => !relayableStreams.includes(name))
    ).toEqual([])
  })
})
