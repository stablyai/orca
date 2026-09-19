import { expect, it, vi } from 'vitest'
import { registerRelayPtyOwnershipSourceEndpoint } from './relay-pty-ownership-source-endpoint'
import {
  PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD,
  parsePtyOwnershipSourceEndpoint
} from '../shared/pty-ownership-source-endpoint'
import type { MethodHandler, RequestContext } from './dispatcher'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime'
}
function fixture(enabled = true) {
  const handlers = new Map<string, MethodHandler>()
  const authorizes = vi.fn(() => true)
  const resolve = vi.fn(() => ({ terminalId: 'pty', incarnationId: 'incarnation' }))
  const readEndpoint = vi.fn<
    Parameters<typeof registerRelayPtyOwnershipSourceEndpoint>[0]['readEndpoint']
  >(() => ({
    endpoint: '/host/relay.sock',
    incumbentVersion: 'host-build',
    endpointCredential: 'a'.repeat(43)
  }))
  const context: RequestContext = {
    clientId: 7,
    isStale: () => false,
    sessionIdentity: {
      principal: 'owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  }
  registerRelayPtyOwnershipSourceEndpoint({
    enabled,
    dispatcher: {
      onRequest: (method, handler) => {
        handlers.set(method, handler)
      }
    },
    source: { authorizes },
    handler: { resolveOwnershipTransferTerminal: resolve },
    readEndpoint
  })
  const call = async () =>
    handlers.get(PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD)!({ version: 1, ...identity }, context)
  return { handlers, call, context, authorizes, resolve, readEndpoint }
}
it('returns current host-owned evidence only for the authenticated source owner', async () => {
  const f = fixture()
  expect(parsePtyOwnershipSourceEndpoint(await f.call(), identity)).toEqual({
    version: 1,
    identity,
    ...f.readEndpoint.mock.results[0].value
  })
  expect(f.authorizes).toHaveBeenCalledWith('pty', 'lease', 1, 7)
})
it('does not register the endpoint credential RPC without explicit opt-in', () => {
  expect(fixture(false).handlers.has(PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD)).toBe(false)
})
it.each(['unauthenticated', 'non-owner', 'stale', 'wrong-lease', 'wrong-incarnation'])(
  'does not read credentials for %s requests',
  async (failure) => {
    const f = fixture()
    if (failure === 'unauthenticated') {
      f.context.sessionIdentity!.authenticated = false
    }
    if (failure === 'non-owner') {
      f.context.sessionIdentity!.allowSessionOwner = false
    }
    if (failure === 'stale') {
      f.context.isStale = () => true
    }
    if (failure === 'wrong-lease') {
      f.authorizes.mockReturnValue(false)
    }
    if (failure === 'wrong-incarnation') {
      f.resolve.mockReturnValue({ terminalId: 'pty', incarnationId: 'other' })
    }
    await expect(f.call()).rejects.toThrow('unauthorized')
    expect(f.readEndpoint).not.toHaveBeenCalled()
  }
)
it('refuses when the daemon no longer owns its endpoint', async () => {
  const f = fixture()
  f.readEndpoint.mockReturnValue(null)
  await expect(f.call()).rejects.toThrow('unverifiable')
})
it('refuses stale authority at the credential read boundary', async () => {
  const f = fixture()
  f.readEndpoint.mockImplementationOnce(() => {
    f.context.isStale = () => true
    return {
      endpoint: '/host/relay.sock',
      incumbentVersion: 'host-build',
      endpointCredential: 'a'.repeat(43)
    }
  })
  await expect(f.call()).rejects.toThrow('unverifiable')
})
it('rejects malformed credentials and another transfer identity', async () => {
  const reply = (await fixture().call()) as Record<string, unknown>
  expect(() =>
    parsePtyOwnershipSourceEndpoint({ ...reply, endpointCredential: 'short' }, identity)
  ).toThrow()
  expect(() => parsePtyOwnershipSourceEndpoint(reply, { ...identity, bridgeId: 'other' })).toThrow(
    'invalid'
  )
})
