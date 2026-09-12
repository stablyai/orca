import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../shared/worktree/host-qualified-identity'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { unqualifyOrcadMigrationOwnerKey } from '../persistence/migrating-orcad-catalog/orcad-source-scope'
import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import { projectOrcadSourceLiveState } from '../persistence/migrating-orcad-catalog/orcad-source-live-state-projection'

/** Caller holds target/environment lifecycle locks; no preparation or source mutation occurs here. */
export function bindOutgoingOrcadCatalogSource(options: {
  targetId: string
  identities: readonly unknown[]
  runtime: Pick<OrcaRuntimeService, 'bindOutgoingSshPtyCatalogSurfaces'>
  store: Pick<Store, 'getSshRemotePtyLeases' | 'getSshPtyConsumerRecovery'>
  signal: AbortSignal
  assertAuthority: () => void
}) {
  options.signal.throwIfAborted()
  options.assertAuthority()
  const inventory = options.runtime.bindOutgoingSshPtyCatalogSurfaces(options.targetId)
  const identities = options.identities.map(parsePtyOwnershipTransferWireIdentity)
  if (
    identities.length === 0 ||
    identities.length !== inventory.surfaces.length ||
    new Set(identities.map((entry) => entry.terminalId)).size !== identities.length ||
    new Set(identities.map((entry) => entry.bridgeId)).size !== identities.length ||
    new Set(identities.map((entry) => entry.destinationRuntimeId)).size !== 1
  ) {
    throw new Error('orcad_outgoing_catalog_source_inventory_mismatch')
  }
  const bindings = inventory.surfaces.map((surface) => {
    const identity = identities.find((entry) => entry.terminalId === surface.surfaceBinding.ptyId)
    if (!identity || identity.incarnationId !== surface.incarnationId) {
      throw new Error('orcad_outgoing_catalog_source_inventory_mismatch')
    }
    const source = bindOutgoingOrcadSource({
      identity,
      ptyId: surface.ptyId,
      sourceSshTargetId: options.targetId,
      signal: options.signal,
      assertAuthority: options.assertAuthority
    })
    return { identity, surfaceBinding: surface.surfaceBinding, source }
  })
  const readEvidence = () => {
    const leases = options.store.getSshRemotePtyLeases(options.targetId)
    const unresolved = leases.filter((lease) => lease.state !== 'terminated')
    const recovery = options.store.getSshPtyConsumerRecovery(options.targetId)
    if (
      unresolved.length !== bindings.length ||
      leases.some((lease) => lease.pendingKill !== undefined) ||
      !recovery ||
      recovery.targetId !== options.targetId ||
      bindings.some(({ identity, surfaceBinding }) => {
        const matches = unresolved.filter((lease) => lease.ptyId === identity.terminalId)
        const lease = matches[0]
        const workspace = parseWorkspaceKey(surfaceBinding.workspaceKey)!
        const owner =
          workspace.type === 'folder'
            ? `folder:${workspace.folderWorkspaceId}`
            : workspace.worktreeId
        return (
          matches.length !== 1 ||
          !lease ||
          lease.targetId !== options.targetId ||
          lease.state !== 'attached' ||
          lease.supersededBy !== undefined ||
          lease.relayIdRecycled === true ||
          !lease.worktreeId ||
          (isWorktreeHostIdentity(lease.worktreeId) &&
            getExecutionHostIdFromWorktreeHostIdentity(lease.worktreeId) !==
              toSshExecutionHostId(options.targetId)) ||
          unqualifyOrcadMigrationOwnerKey(lease.worktreeId) !== owner ||
          lease.tabId !== surfaceBinding.tabId ||
          lease.leafId !== surfaceBinding.leafId ||
          recovery.ownerLease !== identity.ownerLease ||
          recovery.ownerGeneration !== identity.sourceOwnerGeneration
        )
      })
    ) {
      throw new Error('orcad_outgoing_catalog_source_lease_mismatch')
    }
    return { leases, recovery }
  }
  const admittedEvidence = structuredClone(readEvidence())
  const evidence = serializeOrcadMigrationValue(admittedEvidence)
  const assertRuntimeCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    inventory.assertCurrent()
    for (const binding of bindings) {
      binding.source.assertSource()
    }
  }
  const assertCurrent = () => {
    assertRuntimeCurrent()
    if (serializeOrcadMigrationValue(readEvidence()) !== evidence) {
      throw new Error('orcad_outgoing_catalog_source_evidence_changed')
    }
  }
  assertCurrent()
  const bindingEvidence = serializeOrcadMigrationValue(
    bindings.map(({ identity, surfaceBinding }) => ({ identity, surfaceBinding }))
  )
  return {
    async fenceCreation() {
      assertCurrent()
      const providers = [...new Set(bindings.map(({ source }) => source.provider))]
      if (providers.some((provider) => !provider.fenceOutgoingCatalogCreation)) {
        throw new Error('orcad_outgoing_catalog_creation_fence_unsupported')
      }
      await Promise.all(
        providers.map((provider) => provider.fenceOutgoingCatalogCreation!(options.signal))
      )
      assertCurrent()
    },
    assertBindings(value: unknown) {
      assertCurrent()
      if (serializeOrcadMigrationValue(value) !== bindingEvidence) {
        throw new Error('orcad_outgoing_catalog_source_binding_mismatch')
      }
    },
    projectSourceState(
      state: Parameters<typeof projectOrcadSourceLiveState>[0],
      source: Parameters<typeof projectOrcadSourceLiveState>[1],
      catalog: Parameters<typeof projectOrcadSourceLiveState>[2]
    ) {
      assertCurrent()
      if (source.sshTargetId !== options.targetId) {
        throw new Error('orcad_outgoing_catalog_source_inventory_mismatch')
      }
      return projectOrcadSourceLiveState(state, source, catalog, { bindings, ...admittedEvidence })
    },
    bindings: bindings.map(({ identity, surfaceBinding }) =>
      structuredClone({ identity, surfaceBinding })
    ),
    assertRuntimeCurrent,
    assertCurrent
  }
}
