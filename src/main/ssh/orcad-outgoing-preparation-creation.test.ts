import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createOutgoingOrcadPreparation,
  createOutgoingOrcadCatalogPreparationUnderAuthority
} from './orcad-outgoing-preparation-creation'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  target: vi.fn(),
  environment: vi.fn(),
  endpoint: vi.fn()
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: mocks.provider,
  getProviderForPty: mocks.provider
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ getTarget: mocks.target })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => undefined }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.environment }))
vi.mock('./orcad-outgoing-source-endpoint', () => ({
  discoverOutgoingOrcadSourceEndpoint: mocks.endpoint
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-create-intent-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  mocks.endpoint.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = {
    terminalId: 'pty',
    incarnationId: 'incarnation',
    ownerLease: 'lease',
    sourceOwnerGeneration: 1
  }
  const provider = {
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity: () => source,
    requestHostRpc: vi.fn()
  }
  mocks.provider.mockReturnValue(provider)
  const target = { id: 'source', generation: 1, host: 'host' }
  mocks.target.mockReturnValue(target)
  const environment = {
    id: 'destination',
    runtimeId: 'runtime',
    createdAt: 1,
    preferredEndpointId: 'endpoint',
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ]
  }
  mocks.environment.mockReturnValue(environment)
  mocks.endpoint.mockImplementation(async (options) => {
    expect(targetLifecycleInFlight.has(target.id)).toBe(true)
    options.assertAuthority()
    return {
      version: 1,
      identity: options.identity,
      endpoint: '/host/relay.sock',
      incumbentVersion: 'build',
      endpointCredential: 'a'.repeat(43)
    }
  })
  const args = {
    selector: 'destination',
    ptyId: 'ssh:source@@pty',
    signal: new AbortController().signal,
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey: 'folder:folder',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty'
    }
  }
  return { args, provider, target, source, environment }
}
it('creates a durable intent from provider identity and discovered endpoint without source mutation', async () => {
  const f = fixture()
  const intent = await createOutgoingOrcadPreparation(root, f.args)
  expect(intent.identity).toMatchObject({ ...f.source, destinationRuntimeId: 'runtime' })
  expect(intent.source.proof.credential).toMatch(/^[a-f0-9]{64}$/)
  expect(intent.source.endpoint).toBe('/host/relay.sock')
  expect(new OrcadOutgoingPreparationStore(root).read(intent.identity)).toEqual(intent)
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})
it('does not persist intent when the source surface moves during discovery', async () => {
  const f = fixture()
  let current = true
  const discover = mocks.endpoint.getMockImplementation()!
  mocks.endpoint.mockImplementationOnce(async (options) => {
    const endpoint = await discover(options)
    current = false
    return endpoint
  })
  await expect(
    createOutgoingOrcadPreparation(root, {
      ...f.args,
      assertSurface: () => {
        if (!current) {
          throw new Error('surface moved')
        }
      }
    })
  ).rejects.toThrow('surface moved')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([])
})
it('reuses the exact stored credential and identity on retry without rediscovering', async () => {
  const f = fixture()
  const first = await createOutgoingOrcadPreparation(root, f.args)
  expect(await createOutgoingOrcadPreparation(root, f.args)).toEqual(first)
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})
it('serializes concurrent intent creation into one transfer', async () => {
  const f = fixture()
  const [first, second] = await Promise.all([
    createOutgoingOrcadPreparation(root, f.args),
    createOutgoingOrcadPreparation(root, f.args)
  ])
  expect(second).toEqual(first)
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})
it('requires recovery when an existing intent names another surface', async () => {
  const f = fixture()
  const first = await createOutgoingOrcadPreparation(root, f.args)
  await expect(
    createOutgoingOrcadPreparation(root, {
      ...f.args,
      surfaceBinding: { ...f.args.surfaceBinding, tabId: 'other' }
    })
  ).rejects.toThrow('recovery_required')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})
it('does not persist endpoint evidence after a source generation change', async () => {
  const f = fixture()
  const discover = mocks.endpoint.getMockImplementation()!
  mocks.endpoint.mockImplementationOnce(async (options) => {
    const result = await discover(options)
    f.target.generation++
    return result
  })
  await expect(createOutgoingOrcadPreparation(root, f.args)).rejects.toThrow('authority_changed')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([])
})
it('requires recovery instead of minting for a different source incarnation', async () => {
  const f = fixture()
  const first = await createOutgoingOrcadPreparation(root, f.args)
  f.source.incarnationId = 'other'
  await expect(createOutgoingOrcadPreparation(root, f.args)).rejects.toThrow('recovery_required')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
})

function catalogFixture() {
  const f = fixture()
  const { admission } = terminalLayoutAdmissionFixture('folder')
  const { identity, surfaceBinding } = admission.bindings[0]
  Object.assign(f.source, identity)
  f.target.id = admission.manifest.source.sshTargetId
  f.environment.runtimeId = identity.destinationRuntimeId
  const binding = {
    version: 2,
    identity,
    destinationEnvironmentId: f.environment.id,
    sourceSshTargetId: f.target.id,
    sourceSshTargetGeneration: f.target.generation,
    catalogAdmission: admission
  }
  const args = {
    ...f.args,
    ptyId: `ssh:${f.target.id}@@${identity.terminalId}`,
    surfaceBinding
  }
  const run = (value = binding) =>
    withOutgoingOrcadAuthority(
      root,
      { binding: value, signal: args.signal, assertEvidence: () => undefined },
      async ({ assertAuthority }) => {
        await Promise.resolve()
        return createOutgoingOrcadCatalogPreparationUnderAuthority(root, {
          ...args,
          binding: value,
          assertAuthority
        })
      }
    )
  return { ...f, args, binding, run }
}

it('creates catalog credentials under held locks and reuses exact admitted authority on retry', async () => {
  const f = catalogFixture()
  const first = await f.run()
  expect(first).toMatchObject(f.binding)
  expect(first.source.proof.credential).toMatch(/^[a-f0-9]{64}$/)
  expect(await f.run()).toEqual(first)
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('does not convert a legacy preparation into catalog authority', async () => {
  const f = catalogFixture()
  const first = await createOutgoingOrcadPreparation(root, f.args)
  await expect(f.run()).rejects.toThrow('recovery_required')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})

it('rejects a changed admitted bridge on retry without rediscovery', async () => {
  const f = catalogFixture()
  const first = await f.run()
  const changed = structuredClone(f.binding)
  changed.identity = { ...changed.identity, bridgeId: 'replacement-bridge' }
  changed.catalogAdmission = {
    ...changed.catalogAdmission,
    bindings: changed.catalogAdmission.bindings.map((entry, index) =>
      index === 0 ? { ...entry, identity: changed.identity } : entry
    )
  }
  await expect(f.run(changed)).rejects.toThrow('recovery_required')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})

it('rejects lost caller authority after discovery without persisting credentials', async () => {
  const f = catalogFixture()
  let current = true
  mocks.endpoint.mockImplementationOnce(async () => {
    current = false
    return {
      endpoint: '/host/relay.sock',
      incumbentVersion: 'build',
      endpointCredential: 'a'.repeat(43)
    }
  })
  await expect(
    createOutgoingOrcadCatalogPreparationUnderAuthority(root, {
      ...f.args,
      binding: f.binding,
      assertAuthority: () => {
        if (!current) {
          throw new Error('lost authority')
        }
      }
    })
  ).rejects.toThrow('lost authority')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([])
})

it('rejects changed sibling catalog authority while preserving this terminal credential', async () => {
  const f = catalogFixture()
  const first = await f.run()
  const changed = structuredClone(f.binding)
  changed.catalogAdmission = {
    ...changed.catalogAdmission,
    bindings: changed.catalogAdmission.bindings.map((entry, index) =>
      index === 1
        ? { ...entry, identity: { ...entry.identity, bridgeId: 'replacement-sibling' } }
        : entry
    )
  }
  await expect(f.run(changed)).rejects.toThrow('recovery_required')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([first])
  expect(mocks.endpoint).toHaveBeenCalledOnce()
})

it('rejects an identity outside the admitted catalog before discovering the source', async () => {
  const f = catalogFixture()
  const changed = {
    ...f.binding,
    identity: { ...f.binding.identity, bridgeId: 'unadmitted-bridge' }
  }
  await expect(f.run(changed)).rejects.toThrow('catalog_identity_mismatch')
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([])
  expect(mocks.endpoint).not.toHaveBeenCalled()
})
