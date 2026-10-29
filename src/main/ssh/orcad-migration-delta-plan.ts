/** Subtract earlier migrations' currently retained rows/state; export only additions. Never merge overlapping old source copies over server-owned state. */
import type { OrcadDeltaMovePreview, OrcadDeltaMoveRow } from '../../shared/orcad-managed-runtime'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import { isRetainedOrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import { listOrcadMigrationCutoverChainForTarget } from './orcad-migration-cutover-journal'
import {
  createOrcadMigrationManifest,
  orcadMigrationCatalogIds,
  type OrcadMigrationCatalogIds
} from './orcad-migration-manifest-export'
import type { OrcadMigrationSnapshotSource } from './orcad-migration-snapshot-coordinator'
import { collectUntransferredDependentBlockers } from './targets/ssh-target-orcad-dependents'
import type { OrcadMigrationPreflightStore } from './targets/ssh-target-orcad-preflight'

export type OrcadDeltaSourceStore = OrcadMigrationPreflightStore & OrcadMigrationSnapshotSource

export function unfinishedOrcadDelta(
  chain: readonly OrcadMigrationSourceCutover[]
): OrcadMigrationSourceCutover | null {
  const head = chain.at(-1)
  return head?.supersedesMigrationId &&
    head.phase !== 'source-retired' &&
    !isRetainedOrcadMigrationSourceCutover(head)
    ? head
    : null
}

export function committedOrcadMigrationChain(
  chain: readonly OrcadMigrationSourceCutover[]
): OrcadMigrationSourceCutover[] {
  return (unfinishedOrcadDelta(chain) ? chain.slice(0, -1) : chain).filter(
    (cutover) => cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
  )
}

export function orcadDeltaSourceStore(
  store: Store,
  target: SshTarget,
  moved: readonly OrcadMigrationSourceCutover[],
  /** Older interrupted deltas may still include server-owned groups. */
  journaled?: OrcadMigrationManifest
): OrcadDeltaSourceStore {
  const ids = orcadMigrationCatalogIds(moved.map((cutover) => cutover.manifest.payload))
  // Never move projects/groups already owned through earlier links.
  const linked = moved.flatMap((cutover) => cutover.linkedRepositoryIds ?? [])
  const linkedGroups = moved.flatMap((cutover) => cutover.linkedProjectGroupIds ?? [])
  const linkedFolders = moved.flatMap((cutover) => cutover.linkedFolderWorkspaceIds ?? [])
  // New rows reference server-owned groups; exporting retained copies could overwrite newer server edits.
  const serverGroups = new Set([...ids.projectGroupIds, ...linkedGroups])
  const exported = new Set(journaled?.payload.projectGroups.map((group) => group.id))
  return orcadSourceStoreWithout(
    store,
    target,
    {
      ...ids,
      repositoryIds: new Set([...ids.repositoryIds, ...linked]),
      folderWorkspaceIds: new Set([...ids.folderWorkspaceIds, ...linkedFolders]),
      projectGroupIds: serverGroups
    },
    moved.at(-1)?.destinationEnvironmentId,
    new Set([...serverGroups].filter((id) => !exported.has(id)))
  )
}

export function orcadSourceStoreWithout(
  store: Store,
  target: SshTarget,
  owned: OrcadMigrationCatalogIds,
  destinationEnvironmentId: string | undefined,
  /** Groups the server's record wins for: never exported, even while a moving row sits in one. */
  serverGroupIds: ReadonlySet<string> = new Set()
): OrcadDeltaSourceStore {
  const ownedNow = createOrcadMigrationManifest(store, target, {
    destinationEnvironmentId,
    onlyCatalog: owned
  })
  const view = store.createOrcadMigrationDeltaView(ownedNow)
  return {
    ...view,
    serverOwnedProjectGroupIds: serverGroupIds,
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    readOrcadMigrationSourceSnapshotChunk: (...args) =>
      store.readOrcadMigrationSourceSnapshotChunk(...args)
  }
}

export type OrcadDeltaMovePlan = OrcadDeltaMovePreview & {
  manifest: OrcadMigrationManifest
  moved: OrcadMigrationSourceCutover[]
  head: OrcadMigrationSourceCutover
  resumes: OrcadMigrationSourceCutover | null
  source: OrcadDeltaSourceStore
}

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
  const chain = listOrcadMigrationCutoverChainForTarget(userDataPath, target.id)
  const resumes = unfinishedOrcadDelta(chain)
  const moved = committedOrcadMigrationChain(chain)
  const head = chain.at(resumes ? -2 : -1)
  if (
    !head ||
    !isRetainedOrcadMigrationSourceCutover(head) ||
    moved.at(-1)?.migrationId !== head.migrationId
  ) {
    throw new Error('orcad_delta_no_retained_migration')
  }
  const source = orcadDeltaSourceStore(store, target, moved, resumes?.manifest)
  const manifest =
    resumes?.manifest ??
    createOrcadMigrationManifest(source, target, {
      migrationId: options.migrationId,
      now: options.now,
      destinationEnvironmentId: environmentId
    })
  const current = collectOrcadMigrationSourceCatalog(store, target)
  return {
    sshTargetId: target.id,
    environmentId,
    added: catalogRows(manifest.payload),
    notReflected: notReflected(
      current,
      moved.map((cutover) => cutover.manifest.payload)
    ),
    blockers: collectUntransferredDependentBlockers(source, manifest),
    manifest,
    moved,
    head,
    resumes,
    source
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
