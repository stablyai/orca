import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD } from '../../shared/pty-ownership-transfer-runtime-methods'
import { assertOrcadLiveMigrationPreflight } from './orcad-live-migration-preflight'

const f = vi.hoisted(() => ({ send: vi.fn(), provider: vi.fn(), route: vi.fn() }))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: f.send }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: f.provider,
  getProviderForPty: f.route
}))
const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'token',
  publicKeyB64: 'key',
  pairedDeviceId: 'device'
})
const identities = [1, 2].map((id) => ({
  bridgeId: `bridge-${id}`,
  terminalId: `terminal-${id}`,
  incarnationId: `incarnation-${id}`,
  ownerLease: 'owner',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime'
}))
const sourceSupport = {
  protocolVersions: [1],
  inputDeduplication: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true,
  postCommitReplay: true,
  reconnectRekey: true,
  statusQuery: true,
  preparationShutdownGuardVersion: 1,
  transferGraceGuardVersion: 1,
  transferLifecycleGuardVersion: 1,
  destinationDelegationVersion: 1,
  captureBoundaryVersion: 1,
  captureSelectionVersion: 1,
  captureSelectionRecoveryVersion: 1,
  sourceRetirementVersion: 1,
  sourceRetirementBoundaryVersion: 1,
  sourceRetirementRecoveryVersion: 1
}
const destinationSupport = {
  version: 1,
  catalogPublication: 1,
  catalogActivation: 1,
  sourceRetirement: 1,
  sourceRetirementRecovery: 1,
  catalogMigrationVersion: 1,
  sessionTerminalIdentity: 1
}
const response = (result: unknown, runtimeId = 'runtime') => ({
  ok: true,
  result,
  _meta: { runtimeId }
})
function fixture() {
  const controller = new AbortController()
  const authority = vi.fn()
  const provider = {
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity: vi.fn((ptyId: string) =>
      identities.find(({ terminalId }) => toAppSshPtyId('target', terminalId) === ptyId)
    ),
    getOwnershipBridgeCapabilities: vi.fn(async () => ({ ...sourceSupport })),
    requestHostRpc: vi.fn(),
    drainOutgoingSourceControls: vi.fn(),
    fenceOutgoingCatalogCreation: vi.fn()
  }
  f.provider.mockReturnValue(provider)
  f.route.mockReturnValue(provider)
  const options = {
    pairingCode,
    targetId: 'target',
    identities,
    signal: controller.signal,
    assertAuthority: authority
  }
  return {
    provider,
    controller,
    authority,
    options,
    run: () => assertOrcadLiveMigrationPreflight(options)
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  f.send.mockResolvedValue(response(destinationSupport))
})
afterEach(() => vi.unstubAllEnvs())

it('deduplicates shared-provider probes while validating every source without fencing or writes', async () => {
  const s = fixture()
  await s.run()
  expect(s.provider.getOwnershipBridgeCapabilities).toHaveBeenCalledExactlyOnceWith({
    signal: s.controller.signal
  })
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.send.mock.calls[0][1]).toBe(PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD)
  expect(f.send.mock.calls[0][2]).toEqual({ version: 1 })
  expect(f.send.mock.calls[0][5]).toBe(s.controller.signal)
  for (const identity of identities) {
    expect(
      s.provider.getOwnershipTransferSourceIdentity.mock.calls.filter(
        ([id]) => id === toAppSshPtyId('target', identity.terminalId)
      ).length
    ).toBeGreaterThan(2)
  }
  expect(s.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(s.provider.drainOutgoingSourceControls).not.toHaveBeenCalled()
  expect(s.provider.fenceOutgoingCatalogCreation).not.toHaveBeenCalled()
})

it.each(Object.keys(sourceSupport))(
  'refuses absent source %s before destination contact',
  async (key) => {
    const s = fixture()
    const support = { ...sourceSupport }
    Reflect.deleteProperty(support, key)
    s.provider.getOwnershipBridgeCapabilities.mockResolvedValue(support)
    await expect(s.run()).rejects.toThrow('source_preflight_unsupported')
    expect(f.send).not.toHaveBeenCalled()
  }
)

it.each(Object.keys(sourceSupport))('refuses unsupported source %s', async (key) => {
  const s = fixture()
  const support = { ...sourceSupport }
  Reflect.set(support, key, typeof Reflect.get(support, key) === 'boolean' ? 'true' : 2)
  s.provider.getOwnershipBridgeCapabilities.mockResolvedValue(support)
  await expect(s.run()).rejects.toThrow('source_preflight_unsupported')
})

it.each([[], [2], ['1'], 1, null])(
  'refuses malformed or unsupported protocol versions %j',
  async (versions) => {
    const s = fixture()
    const support = { ...sourceSupport }
    Reflect.set(support, 'protocolVersions', versions)
    s.provider.getOwnershipBridgeCapabilities.mockResolvedValue(support)
    await expect(s.run()).rejects.toThrow('source_preflight_unsupported')
    expect(f.send).not.toHaveBeenCalled()
  }
)

it('accepts additional protocols when the supported version is present', async () => {
  const s = fixture()
  s.provider.getOwnershipBridgeCapabilities.mockResolvedValue({
    ...sourceSupport,
    protocolVersions: [2, 1]
  })
  await expect(s.run()).resolves.toBeUndefined()
})

it.each([
  'getOwnershipBridgeCapabilities',
  'drainOutgoingSourceControls',
  'fenceOutgoingCatalogCreation'
])('requires actual provider method %s', async (key) => {
  const s = fixture()
  Reflect.deleteProperty(s.provider, key)
  await expect(s.run()).rejects.toThrow('source_preflight_unsupported')
  expect(f.send).not.toHaveBeenCalled()
})

it.each(Object.keys(destinationSupport))('refuses absent destination %s', async (key) => {
  const s = fixture()
  const support = { ...destinationSupport }
  Reflect.deleteProperty(support, key)
  f.send.mockResolvedValue(response(support))
  await expect(s.run()).rejects.toThrow('destination_preflight_unsupported')
})

it.each(Object.keys(destinationSupport))('refuses unsupported destination %s', async (key) => {
  const s = fixture()
  f.send.mockResolvedValue(response({ ...destinationSupport, [key]: 2 }))
  await expect(s.run()).rejects.toThrow('destination_preflight_unsupported')
})

it.each([null, [], 'supported'])('rejects malformed destination support %j', async (support) => {
  const s = fixture()
  f.send.mockResolvedValue(response(support))
  await expect(s.run()).rejects.toThrow('destination_preflight_unsupported')
})

it('rejects capability replies from another authenticated runtime', async () => {
  const s = fixture()
  f.send.mockResolvedValue(response(destinationSupport, 'other-runtime'))
  await expect(s.run()).rejects.toThrow('runtime_mismatch')
})

it('does not translate failed capability RPCs into support', async () => {
  const s = fixture()
  f.send.mockResolvedValue({ ok: false, error: { code: 'method_not_found' } })
  await expect(s.run()).rejects.toThrow('failed:method_not_found')
})

it.each(['before', 'source', 'destination'])(
  'honors cancellation at %s probe boundary',
  async (stage) => {
    const s = fixture()
    const cancel = () => s.controller.abort(new Error('canceled'))
    if (stage === 'before') {
      cancel()
    }
    if (stage === 'source') {
      s.provider.getOwnershipBridgeCapabilities.mockImplementation(async () => {
        cancel()
        return sourceSupport
      })
    }
    if (stage === 'destination') {
      f.send.mockImplementation(async () => {
        cancel()
        return response(destinationSupport)
      })
    }
    await expect(s.run()).rejects.toThrow('canceled')
    if (stage !== 'destination') {
      expect(f.send).not.toHaveBeenCalled()
    }
  }
)

it.each(['source', 'destination'])(
  'revalidates authority after %s capability wait',
  async (stage) => {
    const s = fixture()
    const change = () =>
      s.authority.mockImplementation(() => {
        throw new Error('authority_changed')
      })
    if (stage === 'source') {
      s.provider.getOwnershipBridgeCapabilities.mockImplementation(async () => {
        change()
        return sourceSupport
      })
    } else {
      f.send.mockImplementation(async () => {
        change()
        return response(destinationSupport)
      })
    }
    await expect(s.run()).rejects.toThrow('authority_changed')
  }
)

it.each(['source', 'destination'])(
  'revalidates the other terminal after %s capability wait',
  async (stage) => {
    const s = fixture()
    const change = () =>
      s.provider.getOwnershipTransferSourceIdentity.mockImplementation((ptyId) =>
        ptyId === toAppSshPtyId('target', identities[1].terminalId) ? undefined : identities[0]
      )
    if (stage === 'source') {
      s.provider.getOwnershipBridgeCapabilities.mockImplementation(async () => {
        change()
        return sourceSupport
      })
    } else {
      f.send.mockImplementation(async () => {
        change()
        return response(destinationSupport)
      })
    }
    await expect(s.run()).rejects.toThrow('source_authority_changed')
  }
)

it('refuses provider replacement during a capability probe', async () => {
  const s = fixture()
  s.provider.getOwnershipBridgeCapabilities.mockImplementation(async () => {
    f.provider.mockReturnValue({ ...s.provider })
    return sourceSupport
  })
  await expect(s.run()).rejects.toThrow('source_authority_changed')
  expect(f.send).not.toHaveBeenCalled()
})

it.each(['empty', 'mixed-runtime', 'duplicate-terminal', 'duplicate-bridge'])(
  'refuses %s identities before probing',
  async (kind) => {
    const s = fixture()
    const candidates = structuredClone(identities)
    if (kind === 'empty') {
      candidates.length = 0
    }
    if (kind === 'mixed-runtime') {
      candidates[1].destinationRuntimeId = 'other'
    }
    if (kind === 'duplicate-terminal') {
      candidates[1].terminalId = candidates[0].terminalId
    }
    if (kind === 'duplicate-bridge') {
      candidates[1].bridgeId = candidates[0].bridgeId
    }
    await expect(
      assertOrcadLiveMigrationPreflight({ ...s.options, identities: candidates })
    ).rejects.toThrow('identity_mismatch')
    expect(s.provider.getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  }
)
