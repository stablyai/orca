/**
 * Planning a delta move for a host an older build changed after it was converted: what the move
 * adds, what the server keeps as it is, and the source view every later check of the move reads.
 *
 * The view retires what the host's earlier migrations already moved, re-exported as it is today,
 * so the delta manifest carries only rows and dormant state no earlier migration owns. Nothing
 * that overlaps an earlier migration is merged into the server.
 */
import type { OrcadDeltaMovePreview, OrcadDeltaMoveRow } from '../../shared/orcad-managed-runtime'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import { isRetainedOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import { listOrcadMigrationCutoverChainForTarget } from './orcad-migration-cutover-journal'
import {
  createOrcadMigrationManifest,
  orcadMigrationCatalogIds
} from './orcad-migration-manifest-export'
import type { OrcadMigrationSnapshotSource } from './orcad-migration-snapshot-coordinator'
import { collectUntransferredDependentBlockers } from './ssh-target-orcad-dependents'
import type { OrcadMigrationPreflightStore } from './ssh-target-orcad-preflight'

export type OrcadDeltaSourceStore = OrcadMigrationPreflightStore & OrcadMigrationSnapshotSource

/** The committed migrations a delta extends, oldest first, excluding any delta in flight. */
export function committedOrcadMigrationChain(
  userDataPath: string,
  targetId: string
): OrcadMigrationSourceCutover[] {
  return listOrcadMigrationCutoverChainForTarget(userDataPath, targetId).filter(
    (cutover) => cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
  )
}

/** The real store, except its catalog and dormant state: those come from the delta view. */
export function orcadDeltaSourceStore(
  store: Store,
  target: SshTarget,
  moved: readonly OrcadMigrationSourceCutover[]
): OrcadDeltaSourceStore {
  const movedNow = createOrcadMigrationManifest(store, target, {
    destinationEnvironmentId: moved.at(-1)?.destinationEnvironmentId,
    onlyCatalog: orcadMigrationCatalogIds(moved.map((cutover) => cutover.manifest.payload))
  })
  const view = store.createOrcadMigrationDeltaView(movedNow)
  return {
    ...view,
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    readOrcadMigrationSourceSnapshotChunk: (...args) =>
      store.readOrcadMigrationSourceSnapshotChunk(...args),
    retainOrcadMigrationScrollback: (manifest) => store.retainOrcadMigrationScrollback(manifest),
    releaseOrcadMigrationScrollback: (migrationId) =>
      store.releaseOrcadMigrationScrollback(migrationId)
  }
}

export type OrcadDeltaMovePlan = OrcadDeltaMovePreview & {
  manifest: OrcadMigrationManifest
  moved: OrcadMigrationSourceCutover[]
}

/** Throws when the host is not a converted host an older build changed. */
export function planOrcadDeltaMove(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  options: { migrationId?: string; now?: () => Date } = {}
): OrcadDeltaMovePlan {
  const environmentId = target.orcadFence?.environmentId
  if (!environmentId || !target.orcadFence?.sourceChangedAt) {
    throw new Error('orcad_delta_not_changed')
  }
  const moved = committedOrcadMigrationChain(userDataPath, target.id)
  const head = listOrcadMigrationCutoverChainForTarget(userDataPath, target.id).at(-1)
  if (
    !head ||
    !isRetainedOrcadMigrationSourceCutover(head) ||
    moved.at(-1)?.migrationId !== head.migrationId
  ) {
    throw new Error('orcad_delta_no_retained_migration')
  }
  const manifest = createOrcadMigrationManifest(
    orcadDeltaSourceStore(store, target, moved),
    target,
    { migrationId: options.migrationId, now: options.now, destinationEnvironmentId: environmentId }
  )
  const current = collectOrcadMigrationSourceCatalog(store, target)
  return {
    sshTargetId: target.id,
    environmentId,
    added: catalogRows(manifest.payload),
    notReflected: notReflected(
      current,
      moved.map((cutover) => cutover.manifest.payload)
    ),
    blockers: collectUntransferredDependentBlockers(
      orcadDeltaSourceStore(store, target, moved),
      manifest
    ),
    manifest,
    moved
  }
}

function catalogRows(catalog: OrcadMigrationCatalogPayload): OrcadDeltaMoveRow[] {
  return [
    ...catalog.repositories.map((row) => ({
      kind: 'repository' as const,
      id: row.id,
      label: row.displayName
    })),
    ...catalog.folderWorkspaces.map((row) => ({
      kind: 'folder-workspace' as const,
      id: row.id,
      label: row.name
    })),
    ...catalog.projectGroups.map((row) => ({
      kind: 'project-group' as const,
      id: row.id,
      label: row.name
    }))
  ]
}

/** Rows earlier migrations moved that an older build has since changed or removed. */
function notReflected(
  current: OrcadMigrationCatalogPayload,
  movedPayloads: readonly OrcadMigrationCatalogPayload[]
): OrcadDeltaMovePreview['notReflected'] {
  const latestMoved = new Map<string, { row: OrcadDeltaMoveRow; identity: string }>()
  for (const payload of movedPayloads) {
    for (const row of catalogRows(payload)) {
      latestMoved.set(`${row.kind}:${row.id}`, { row, identity: identityOf(payload, row) })
    }
  }
  const currentByKey = new Map(
    catalogRows(current).map((row) => [`${row.kind}:${row.id}`, identityOf(current, row)])
  )
  const edited: OrcadDeltaMoveRow[] = []
  const removed: OrcadDeltaMoveRow[] = []
  for (const [key, moved] of latestMoved) {
    const identity = currentByKey.get(key)
    if (identity === undefined) {
      removed.push(moved.row)
    } else if (identity !== moved.identity) {
      edited.push(moved.row)
    }
  }
  return { edited, removed }
}

function identityOf(catalog: OrcadMigrationCatalogPayload, row: OrcadDeltaMoveRow): string {
  switch (row.kind) {
    case 'repository': {
      const repo = catalog.repositories.find((entry) => entry.id === row.id)
      return `${repo?.path}\0${repo?.displayName}`
    }
    case 'folder-workspace': {
      const folder = catalog.folderWorkspaces.find((entry) => entry.id === row.id)
      return `${folder?.folderPath}\0${folder?.name}`
    }
    case 'project-group':
      return catalog.projectGroups.find((entry) => entry.id === row.id)?.name ?? ''
  }
}
