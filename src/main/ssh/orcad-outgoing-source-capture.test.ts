import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureOutgoingOrcadSource } from './orcad-outgoing-source-capture'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../../shared/pty-ownership-capture-wire'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-source-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  const store = new OrcadOutgoingCaptureStore(root)
  const provider = {
    providerGeneration: 42,
    getOwnershipTransferSourceIdentity: vi.fn(() => ({ ...identity })),
    getOwnershipBridgeCapabilities: vi.fn(async () => ({
      captureBoundaryVersion: 1,
      captureSelectionVersion: 1
    })),
    requestHostRpc: vi.fn(async (method: string) => {
      if (method === methods.begin) {
        return { version: 1, captureToken: 'token' }
      }
      if (method === methods.inspect) {
        return { version: 1, boundary: source.selection.boundary }
      }
      if (method === methods.select) {
        expect(store.read(identity)?.selection).toEqual(source.selection)
        return { version: 1, baseline: source.selection }
      }
      return { version: 1, released: true }
    })
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  const options = {
    store,
    identity,
    ptyId: `ssh:source@@${identity.terminalId}`,
    destination: {
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      source: source.store.loadDelegatedSource(identity)!,
      surfaceBinding: preparation.surfacePublication.surfaceBinding
    },
    signal: new AbortController().signal,
    assertAuthority: vi.fn(),
    runtime: {
      serializeSshPtyOwnershipCapture: vi.fn(async () =>
        parsePtyOwnershipInitialModelSnapshot(source.model, identity, source.model.throughSeq)
      )
    }
  }
  return { options, provider, store }
}
it('captures through the registered provider after fresh capability negotiation', async () => {
  const f = fixture()
  await captureOutgoingOrcadSource(f.options)
  expect(f.provider.getOwnershipBridgeCapabilities).toHaveBeenCalledOnce()
  expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.select,
    methods.release
  ])
  expect(f.options.runtime.serializeSshPtyOwnershipCapture).toHaveBeenCalledWith(
    expect.anything(),
    { ptyId: f.options.ptyId, providerGeneration: 42 },
    f.options.signal
  )
})
it.each(['provider', 'owner', 'generation'])(
  'releases the original token when %s changes after begin',
  async (change) => {
    const f = fixture()
    f.provider.requestHostRpc.mockImplementationOnce(async () => {
      if (change === 'provider') {
        registry.provider.mockReturnValue({})
      }
      if (change === 'owner') {
        f.provider.getOwnershipTransferSourceIdentity.mockReturnValue({
          ...identity,
          ownerLease: 'other'
        })
      }
      if (change === 'generation') {
        f.provider.providerGeneration++
      }
      return { version: 1, captureToken: 'token' }
    })
    await expect(captureOutgoingOrcadSource(f.options)).rejects.toThrow('source_authority_changed')
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      methods.begin,
      methods.release
    ])
    expect(f.store.read(identity)).toBeNull()
  }
)
it('refuses a reconnect during capability negotiation before capture begins', async () => {
  const f = fixture()
  f.provider.getOwnershipBridgeCapabilities.mockImplementationOnce(async () => {
    registry.provider.mockReturnValue({})
    return { captureBoundaryVersion: 1, captureSelectionVersion: 1 }
  })
  await expect(captureOutgoingOrcadSource(f.options)).rejects.toThrow('source_authority_changed')
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})
it('refuses saved candidates before capability or capture contact', async () => {
  const f = fixture()
  await captureOutgoingOrcadSource(f.options)
  f.provider.getOwnershipBridgeCapabilities.mockClear()
  f.provider.requestHostRpc.mockClear()
  await expect(captureOutgoingOrcadSource(f.options)).rejects.toThrow('recovery_required')
  expect(f.provider.getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('retains saved evidence and skips selection if authority changes during persistence', async () => {
  const f = fixture()
  const persist = f.store.persist.bind(f.store)
  vi.spyOn(f.store, 'persist').mockImplementationOnce((value) => {
    const saved = persist(value)
    registry.provider.mockReturnValue({})
    return saved
  })
  await expect(captureOutgoingOrcadSource(f.options)).rejects.toThrow('source_authority_changed')
  expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.release
  ])
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).not.toBeNull()
})

it('refuses capture without the mutation canary before host contact', async () => {
  const f = fixture()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '')
  await expect(captureOutgoingOrcadSource(f.options)).rejects.toThrow('source_authority_changed')
  expect(f.provider.getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})
