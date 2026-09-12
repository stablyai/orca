import {
  parseOrcadMigrationManifest,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import { parseOrcadMigrationLiveTerminalBindings } from '../../../shared/orcad-migration-live-terminal-bindings'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import { prepareOrcadMigrationCatalog } from './orcad-catalog-records'

export type OrcadTerminalLayoutAdmission = Readonly<{
  version: 1
  manifest: OrcadMigrationManifest
  bindings: readonly Readonly<{
    identity: PtyOwnershipTransferWireIdentity
    surfaceBinding: PtyOwnershipTransferSurfaceBinding
  }>[]
}>

export function prepareOrcadTerminalLayoutAdmission(
  manifest: OrcadMigrationManifest,
  bindings: OrcadTerminalLayoutAdmission['bindings'],
  state: PersistedState,
  storage?: Pick<StoreRuntimeState, 'dataFile' | 'terminalScrollbackSnapshotStorage'>
): OrcadTerminalLayoutAdmission {
  const admission = parseOrcadTerminalLayoutAdmission({ version: 1, manifest, bindings })
  const staged = state.orcadMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === admission.manifest.migrationId
  )
  if (!staged || staged.manifest.manifestSha256 !== admission.manifest.manifestSha256) {
    throw new Error('orcad_terminal_layout_catalog_not_staged')
  }
  prepareOrcadMigrationCatalog(admission.manifest, state, storage)
  return admission
}

export function parseOrcadTerminalLayoutAdmission(value: unknown): OrcadTerminalLayoutAdmission {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length === 0 ||
    value.bindings.length > 64
  ) {
    throw new Error('orcad_terminal_layout_admission_invalid')
  }
  const manifest = parseOrcadMigrationManifest(value.manifest)
  assertOrcadMigrationManifestDigest(manifest)
  const bindings = parseOrcadMigrationLiveTerminalBindings(
    value.bindings,
    manifest,
    'orcad_terminal_layout_binding_conflict'
  )
  const first = bindings[0]
  const scope = parseWorkspaceKey(first.surfaceBinding.workspaceKey)!
  const owner = scope.type === 'folder' ? `folder:${scope.folderWorkspaceId}` : scope.worktreeId
  const session = manifest.payload.dormantState?.workspaceSession
  const tabs = session?.tabsByWorktree[owner]?.filter(
    (tab) => tab.id === first.surfaceBinding.tabId
  )
  const layout = session?.terminalLayoutsByTabId[first.surfaceBinding.tabId]
  const leaves = collectLayoutLeafIdsInOrder(layout?.root)
  if (
    !session ||
    tabs?.length !== 1 ||
    tabs[0].worktreeId !== owner ||
    tabs[0].ptyId !== null ||
    !layout ||
    leaves.length === 0 ||
    new Set(leaves).size !== leaves.length ||
    leaves.some((leaf) => !isTerminalLeafId(leaf))
  ) {
    throw new Error('orcad_terminal_layout_surface_not_in_catalog')
  }
  const claimedLeaves = new Set<string>()
  const bridges = new Set<string>()
  const terminals = new Set<string>()
  const incarnations = new Set<string>()
  for (const { identity, surfaceBinding: binding } of bindings) {
    const paneKey = `${binding.tabId}:${binding.leafId}`
    if (
      binding.executionHostId !== 'local' ||
      binding.workspaceKey !== first.surfaceBinding.workspaceKey ||
      binding.tabId !== first.surfaceBinding.tabId ||
      !leaves.includes(binding.leafId) ||
      identity.terminalId !== binding.ptyId ||
      identity.destinationRuntimeId !== first.identity.destinationRuntimeId ||
      claimedLeaves.has(binding.leafId) ||
      bridges.has(identity.bridgeId) ||
      terminals.has(identity.terminalId) ||
      incarnations.has(identity.incarnationId) ||
      session.terminalSurfaceTombstonesByPaneKey?.[paneKey] ||
      session.sleepingAgentSessionsByPaneKey?.[paneKey]
    ) {
      throw new Error('orcad_terminal_layout_binding_conflict')
    }
    claimedLeaves.add(binding.leafId)
    bridges.add(identity.bridgeId)
    terminals.add(identity.terminalId)
    incarnations.add(identity.incarnationId)
  }
  return { version: 1, manifest, bindings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
