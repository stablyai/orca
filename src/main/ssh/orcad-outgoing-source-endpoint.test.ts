import { afterEach, expect, it, vi } from 'vitest'
import { discoverOutgoingOrcadSourceEndpoint } from './orcad-outgoing-source-endpoint'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD } from '../../shared/pty-ownership-source-endpoint'

const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))
afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  const identity = {
    terminalId: 'pty',
    incarnationId: 'incarnation',
    ownerLease: 'lease',
    sourceOwnerGeneration: 1,
    bridgeId: 'bridge',
    destinationRuntimeId: 'runtime'
  }
  const reply = {
    version: 1,
    identity,
    endpoint: '/host/relay.sock',
    incumbentVersion: 'build',
    endpointCredential: 'a'.repeat(43)
  }
  const provider = {
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity: () => identity,
    getOwnershipBridgeCapabilities: vi.fn(async () => ({
      liveTransfer: true,
      destinationDelegationVersion: 1
    })),
    requestHostRpc: vi.fn(async () => reply)
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  return {
    provider,
    reply,
    options: {
      identity,
      ptyId: 'ssh:source@@pty',
      sourceSshTargetId: 'source',
      signal: new AbortController().signal,
      assertAuthority: vi.fn()
    }
  }
}
it('discovers only through the pinned provider and returns exact identity-bound evidence', async () => {
  const f = fixture()
  expect(await discoverOutgoingOrcadSourceEndpoint(f.options)).toEqual(f.reply)
  expect(f.provider.requestHostRpc).toHaveBeenCalledWith(
    PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD,
    { version: 1, ...f.options.identity },
    { signal: f.options.signal, timeoutMs: 5_000 }
  )
})
it('does not probe an endpoint without explicit delegated support', async () => {
  const f = fixture()
  f.provider.getOwnershipBridgeCapabilities.mockResolvedValue({
    liveTransfer: true,
    destinationDelegationVersion: 2
  })
  await expect(discoverOutgoingOrcadSourceEndpoint(f.options)).rejects.toThrow('unsupported')
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})
it('rejects another transfer identity in the endpoint reply', async () => {
  const f = fixture()
  f.provider.requestHostRpc.mockResolvedValue({
    ...f.reply,
    identity: { ...f.reply.identity, ownerLease: 'other' }
  })
  await expect(discoverOutgoingOrcadSourceEndpoint(f.options)).rejects.toThrow('invalid')
})
it('discards endpoint evidence if the provider changes while awaiting it', async () => {
  const f = fixture()
  f.provider.requestHostRpc.mockImplementationOnce(async () => {
    registry.provider.mockReturnValue({})
    return f.reply
  })
  await expect(discoverOutgoingOrcadSourceEndpoint(f.options)).rejects.toThrow(
    'source_authority_changed'
  )
})
it('does not fall back when the endpoint RPC is unavailable', async () => {
  const f = fixture()
  f.provider.requestHostRpc.mockRejectedValueOnce(new Error('method_not_found'))
  await expect(discoverOutgoingOrcadSourceEndpoint(f.options)).rejects.toThrow('method_not_found')
  expect(f.provider.requestHostRpc).toHaveBeenCalledOnce()
})
