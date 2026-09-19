import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease, SshPtyConsumerRecovery } from '../../shared/ssh-types'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { collectOrcadMigrationSourceWorkspaceSession } from '../persistence/migrating-orcad-catalog/orcad-source-workspace-session'

const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))
beforeEach(() => vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function fixture() {
  const f = terminalLayoutAdmissionFixture('folder')
  const identities = f.bindings.map(({ identity }) => ({ ...identity, ownerLease: 'owner' }))
  const targetId = f.manifest.source.sshTargetId
  const surfaces = f.bindings.map(({ surfaceBinding }, i) => ({
    ptyId: toAppSshPtyId(targetId, identities[i].terminalId),
    incarnationId: identities[i].incarnationId,
    surfaceBinding
  }))
  const leases: SshRemotePtyLease[] = surfaces.map(({ surfaceBinding }, i) => ({
    targetId,
    ptyId: identities[i].terminalId,
    worktreeId: f.owner,
    tabId: surfaceBinding.tabId,
    leafId: surfaceBinding.leafId,
    state: 'attached',
    createdAt: 1,
    updatedAt: 1
  }))
  const recovery: SshPtyConsumerRecovery = {
    targetId,
    clientInstanceId: 'client',
    serverBuildId: 'build',
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'owner'
  }
  const provider = {
    fenceOutgoingCatalogCreation: vi.fn(),
    providerGeneration: 42,
    requestHostRpc: vi.fn(),
    getOwnershipTransferSourceIdentity: vi.fn((ptyId: string) =>
      identities.find((entry) => toAppSshPtyId(targetId, entry.terminalId) === ptyId)
    )
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  const assertInventory = vi.fn()
  const options = {
    targetId,
    identities,
    runtime: {
      bindOutgoingSshPtyCatalogSurfaces: vi.fn(() => ({ surfaces, assertCurrent: assertInventory }))
    },
    store: {
      getSshRemotePtyLeases: vi.fn(() => structuredClone(leases)),
      getSshPtyConsumerRecovery: vi.fn((): SshPtyConsumerRecovery | null =>
        structuredClone(recovery)
      )
    },
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  return { options, leases, recovery, provider, assertInventory, catalogFixture: f }
}

it('binds complete placement, provider ownership and durable lease/recovery evidence without source RPC', () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  expect(bound.bindings.map((entry) => entry.identity)).toEqual(f.options.identities)
  bound.assertCurrent()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(f.options.store.getSshRemotePtyLeases).toHaveBeenCalledWith(f.options.targetId)
  Object.assign(bound.bindings[0].identity, { ownerLease: 'caller mutation' })
  expect(() => bound.assertCurrent()).not.toThrow()
})

it('fences creation once per provider without issuing source RPCs', async () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  await bound.fenceCreation()
  expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('refuses unsupported creation fencing before changing admission', async () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  Object.defineProperty(f.provider, 'fenceOutgoingCatalogCreation', { value: undefined })
  await expect(bound.fenceCreation()).rejects.toThrow('creation_fence_unsupported')
})

it('revalidates source authority after creation fencing', async () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  f.provider.fenceOutgoingCatalogCreation.mockImplementationOnce(() => {
    f.provider.providerGeneration++
  })
  await expect(bound.fenceCreation()).rejects.toThrow('authority_changed')
  expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce()
})

it('refuses an inventory change while pending creation settles', async () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  const pending = Promise.withResolvers<void>()
  f.provider.fenceOutgoingCatalogCreation.mockReturnValueOnce(pending.promise)
  const fencing = bound.fenceCreation()
  const rejection = expect(fencing).rejects.toThrow('inventory changed')
  f.assertInventory.mockImplementation(() => {
    throw new Error('inventory changed')
  })
  pending.resolve()
  await rejection
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it.each([
  'missing',
  'extra',
  'expired',
  'detached',
  'duplicate',
  'pending-stop',
  'pane',
  'host',
  'superseded',
  'recycled',
  'owner',
  'generation',
  'recovery'
] as const)('refuses %s lease evidence before admitting source catalog', (change) => {
  const f = fixture()
  if (change === 'missing') {
    f.leases.pop()
  }
  if (change === 'extra') {
    f.leases.push({ ...f.leases[0], ptyId: 'extra', state: 'expired' })
  }
  if (change === 'expired' || change === 'detached') {
    f.leases[0].state = change
  }
  if (change === 'duplicate') {
    f.leases[1] = { ...f.leases[0] }
  }
  if (change === 'pending-stop') {
    Object.assign(f.leases[0], { pendingKill: {} })
  }
  if (change === 'pane') {
    f.leases[0].leafId = f.leases[1].leafId
  }
  if (change === 'host') {
    f.leases[0].worktreeId = `ssh:other|${f.leases[0].worktreeId}`
  }
  if (change === 'superseded') {
    f.leases[0].supersededBy = 'other'
  }
  if (change === 'recycled') {
    f.leases[0].relayIdRecycled = true
  }
  if (change === 'owner') {
    f.recovery.ownerLease = 'other'
  }
  if (change === 'generation') {
    f.recovery.ownerGeneration++
  }
  if (change === 'recovery') {
    f.options.store.getSshPtyConsumerRecovery.mockReturnValue(null)
  }
  expect(() => bindOutgoingOrcadCatalogSource(f.options)).toThrow('lease_mismatch')
})

it.each(['provider', 'inventory', 'recovery', 'lease'] as const)(
  'rejects %s drift after admission',
  (change) => {
    const f = fixture()
    const bound = bindOutgoingOrcadCatalogSource(f.options)
    if (change === 'provider') {
      f.provider.providerGeneration++
    }
    if (change === 'inventory') {
      f.assertInventory.mockImplementation(() => {
        throw new Error('inventory changed')
      })
    }
    if (change === 'recovery') {
      f.recovery.clientGeneration++
    }
    if (change === 'lease') {
      f.leases[0].updatedAt++
    }
    expect(() => bound.assertCurrent()).toThrow()
  }
)

it('refuses an incomplete or duplicate proposed transfer set', () => {
  const f = fixture()
  expect(() =>
    bindOutgoingOrcadCatalogSource({ ...f.options, identities: [f.options.identities[0]] })
  ).toThrow('inventory_mismatch')
  expect(() =>
    bindOutgoingOrcadCatalogSource({
      ...f.options,
      identities: [f.options.identities[0], f.options.identities[0]]
    })
  ).toThrow('inventory_mismatch')
})

it('keeps runtime authority checkable after profile leases are retired without admitting new source state', () => {
  const f = fixture()
  const bound = bindOutgoingOrcadCatalogSource(f.options)
  f.options.store.getSshRemotePtyLeases.mockReturnValue([])
  f.options.store.getSshPtyConsumerRecovery.mockReturnValue(null)
  expect(() => bound.assertRuntimeCurrent()).not.toThrow()
  expect(() => bound.assertCurrent()).toThrow('lease_mismatch')
  f.provider.providerGeneration++
  expect(() => bound.assertRuntimeCurrent()).toThrow('source_authority_changed')
})

it('fences cancellation and ownership changes without making source RPCs', () => {
  const f = fixture()
  const controller = new AbortController()
  const bound = bindOutgoingOrcadCatalogSource({ ...f.options, signal: controller.signal })
  controller.abort(new Error('canceled'))
  expect(() => bound.assertCurrent()).toThrow('canceled')
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  const current = bindOutgoingOrcadCatalogSource(f.options)
  f.provider.getOwnershipTransferSourceIdentity.mockReturnValue(undefined)
  expect(() => current.assertCurrent()).toThrow('source_authority_changed')
})

it('projects admitted profile evidence through the existing exporter without changing source authority', () => {
  const f = fixture()
  const { state, manifest, owner } = f.catalogFixture
  const session = structuredClone(manifest.payload.dormantState!.workspaceSession!)
  session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}
  session.terminalPtyIncarnationsByPaneKey = {}
  for (const { identity, surfaceBinding } of f.catalogFixture.bindings) {
    session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId![surfaceBinding.leafId] = toAppSshPtyId(
      f.options.targetId,
      identity.terminalId
    )
    session.terminalPtyIncarnationsByPaneKey[`tab-1:${surfaceBinding.leafId}`] =
      identity.incarnationId
  }
  session.tabsByWorktree[owner][0].ptyId = toAppSshPtyId(
    f.options.targetId,
    f.options.identities[0].terminalId
  )
  state.workspaceSessionsByHostId = { [`ssh:${f.options.targetId}`]: session }
  state.sshRemotePtyLeases = structuredClone(f.leases)
  state.sshPtyConsumerRecoveries = [structuredClone(f.recovery)]
  const before = structuredClone(state)
  const admission = bindOutgoingOrcadCatalogSource(f.options)
  const projected = admission.projectSourceState(state, manifest.source, manifest.payload)
  expect(projected.sshRemotePtyLeases).toEqual([])
  expect(projected.sshPtyConsumerRecoveries).toEqual([])
  expect(
    collectOrcadMigrationSourceWorkspaceSession(projected, manifest.source, manifest.payload)
      .blockedCount
  ).toBe(0)
  expect(state).toEqual(before)
  state.sshRemotePtyLeases[0].updatedAt++
  expect(() => admission.projectSourceState(state, manifest.source, manifest.payload)).toThrow(
    'evidence_changed'
  )
  state.sshRemotePtyLeases = structuredClone(f.leases)
  state.workspaceSession = structuredClone(session)
  expect(() => admission.projectSourceState(state, manifest.source, manifest.payload)).toThrow(
    'partition_conflict'
  )
})
