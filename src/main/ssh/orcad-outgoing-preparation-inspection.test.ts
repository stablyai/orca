import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectOutgoingOrcadPreparation } from './orcad-outgoing-preparation-inspection'
import {
  OrcadOutgoingPreparationStore,
  outgoingOrcadSourcePreparationRequest
} from './orcad-outgoing-preparation-store'
import { OrcadOutgoingPreparationConnectionStore } from './orcad-outgoing-preparation-connection'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation,
  makeDelegatedRelay
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

const mocks = vi.hoisted(() => ({ provider: vi.fn(), authority: vi.fn() }))
vi.mock('../ipc/pty/provider/registry', () => ({ getSshPtyProvider: mocks.provider }))
vi.mock('./orcad-outgoing-authority', () => ({
  withOutgoingOrcadAuthority: async (_path, args, run) => {
    args.assertEvidence()
    return run({ assertAuthority: mocks.authority })
  }
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-inspect-preparation-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  mocks.authority.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const model = createOrcadModelImportFixture(root)
  const store = new OrcadOutgoingPreparationStore(root)
  const previous = { provider: {}, providerGeneration: 1 }
  const saved = store.persistForSource(
    {
      version: 1,
      kind: 'preparation',
      identity,
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      source: model.store.loadDelegatedSource(identity),
      surfaceBinding: preparation.surfacePublication.surfaceBinding
    },
    previous
  )
  const hostStore = new RelayPtyOwnershipTransferFileStore(join(root, 'host'))
  const host = makeDelegatedRelay(hostStore)
  host.prepare(outgoingOrcadSourcePreparationRequest(saved))
  const provider = {
    providerGeneration: 2,
    getOwnershipBridgeCapabilities: vi.fn(async () => ({ statusQuery: true })),
    requestHostRpc: vi.fn(async (_method: string, params: unknown) => host.status(params))
  }
  mocks.provider.mockReturnValue(provider)
  const run = () =>
    inspectOutgoingOrcadPreparation(root, { identity, signal: new AbortController().signal })
  return { store, saved, provider, hostStore, run }
}

it('observes exact host preparation over a replacement provider without rebinding or mutating', async () => {
  const f = fixture()
  const connections = new OrcadOutgoingPreparationConnectionStore(root)
  const binding = connections.read(identity)
  const host = f.hostStore.loadAll()
  await expect(f.run()).resolves.toMatchObject({ ...identity, phase: 'prepared' })
  expect(f.provider.requestHostRpc).toHaveBeenCalledExactlyOnceWith(
    'pty.ownershipTransfer.status',
    { version: 1, ...identity },
    expect.objectContaining({ timeoutMs: 5_000, signal: expect.any(AbortSignal) })
  )
  expect(connections.read(identity)).toEqual(binding)
  expect(f.store.read(identity)).toEqual(f.saved)
  expect(f.hostStore.loadAll()).toEqual(host)
})

it('does not convert failed transport or an absent transfer into permission to prepare', async () => {
  const f = fixture()
  f.provider.requestHostRpc.mockRejectedValueOnce(new Error('connection lost'))
  await expect(f.run()).rejects.toThrow('connection lost')
  f.provider.requestHostRpc.mockRejectedValueOnce(new Error('transfer not found'))
  await expect(f.run()).rejects.toThrow('transfer not found')
  expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
    'pty.ownershipTransfer.status',
    'pty.ownershipTransfer.status'
  ])
})

it.each(['recorded', 'unverifiable', 'wrong-incarnation'])(
  'joins creation inspection with retained preparation authority (%s)',
  async (mode) => {
    const f = fixture()
    const operationId = 'a'.repeat(43)
    const connections = new OrcadOutgoingPreparationConnectionStore(root)
    const before = connections.read(identity)
    const statusRequest = f.provider.requestHostRpc
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'pty.getCapabilities') {
        return { agentSessionCreateOperationInspectionVersion: 1 }
      }
      if (method === 'pty.inspectCreateOperation') {
        return {
          version: 1,
          operationId,
          outcome: mode === 'unverifiable' ? mode : 'recorded',
          terminalId: identity.terminalId,
          incarnationId: mode === 'wrong-incarnation' ? 'replacement' : identity.incarnationId
        }
      }
      return statusRequest(method, params)
    })
    Object.assign(f.provider, { requestHostRpc: request })
    const inspection = inspectOutgoingOrcadPreparation(root, {
      identity,
      signal: new AbortController().signal,
      creationOperationId: operationId
    })
    await (mode === 'wrong-incarnation'
      ? expect(inspection).rejects.toThrow('creation_identity_mismatch')
      : expect(inspection).resolves.toMatchObject({
          ...identity,
          phase: 'prepared',
          creationOperation: { operationId, outcome: mode }
        }))
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'pty.ownershipTransfer.status',
      'pty.getCapabilities',
      'pty.inspectCreateOperation'
    ])
    expect(connections.read(identity)).toEqual(before)
    expect(f.store.read(identity)).toEqual(f.saved)
  }
)

it('refuses provider drift during status without accepting a stale observation', async () => {
  const f = fixture()
  const request = f.provider.requestHostRpc.getMockImplementation()!
  f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => {
    const status = await request(method, params)
    mocks.provider.mockReturnValue({ ...f.provider })
    return status
  })
  await expect(f.run()).rejects.toThrow('source_authority_changed')
})

it('requires status capability before sending a probe', async () => {
  const f = fixture()
  f.provider.getOwnershipBridgeCapabilities.mockResolvedValue({ statusQuery: false })
  await expect(f.run()).rejects.toThrow('status_unsupported')
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('rejects a response naming a different incarnation', async () => {
  const f = fixture()
  const request = f.provider.requestHostRpc.getMockImplementation()!
  f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => ({
    ...(await request(method, params)),
    incarnationId: 'other'
  }))
  await expect(f.run()).rejects.toThrow()
})

it.each(['missing', 'conflicting'])(
  'refuses %s delegation evidence without mutation',
  async (mode) => {
    const f = fixture()
    const request = f.provider.requestHostRpc.getMockImplementation()!
    f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => ({
      ...(await request(method, params)),
      destinationDelegation:
        mode === 'missing' ? undefined : { version: 1 as const, credentialSha256: '0'.repeat(64) }
    }))
    await expect(f.run()).rejects.toThrow('delegation_unverifiable')
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'pty.ownershipTransfer.status'
    ])
  }
)

it('exposes only the credential digest and returns detached immutable binding data', async () => {
  const f = fixture()
  const result = await f.run()
  expect(result.destinationDelegation).toEqual(
    outgoingOrcadSourcePreparationRequest(f.saved).destinationDelegation
  )
  expect(Object.isFrozen(result.destinationDelegation)).toBe(true)
  expect(JSON.stringify(result)).not.toContain(f.saved.source.proof.credential)
  expect(JSON.stringify(result)).not.toContain(f.saved.source.endpointCredential)
})
