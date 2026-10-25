/** Read-only export preflight: catalog rows and representable dormant state can migrate; ownership, live leases and untransferred dependencies block. */
import { isLiveSshPtyLease } from '../../../shared/ssh-types'
import type { Store } from '../../persistence'
import type {
  OrcadMigrationBlocker,
  OrcadMigrationPreflight
} from '../../../shared/orcad-migration/orcad-migration-preflight'
import {
  createOrcadMigrationManifest,
  type OrcadMigrationExportStore
} from '../orcad-migration-manifest-export'
import {
  collectTargetCatalogBlockers,
  resolveOrcadPreflightTarget
} from './ssh-target-orcad-claims'
import { collectUntransferredDependentBlockers } from './ssh-target-orcad-dependents'
import {
  preservesOrcadMigrationBridgedPanes,
  type OrcadMigrationPaneLeasePredicate
} from '../orcad-migration-bridged-panes'

export type OrcadMigrationPreflightStore = OrcadMigrationExportStore &
  Pick<
    Store,
    'getSshTarget' | 'getSshRemotePtyLeases' | 'inspectOrcadMigrationUntransferredDependencies'
  >

/** `owner` passes the environment's own fence only when its migration journal is on disk. */
export function preflightOrcadMigrationExport(
  store: OrcadMigrationPreflightStore,
  targetId: string,
  owner?: { environmentId: string; recorded: boolean },
  /** COMPAT(legacy-relay-bridge): leases a bridged proof left running for the bridge. */
  bridgedPtyIds: readonly string[] = []
): OrcadMigrationPreflight {
  const resolved = resolveOrcadPreflightTarget(store, targetId, owner)
  if ('result' in resolved) {
    return resolved.result
  }
  const { target } = resolved
  const blockers: OrcadMigrationBlocker[] = [...collectTargetCatalogBlockers(store, target)]
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter((lease) => isLiveSshPtyLease(lease) && !bridgedPtyIds.includes(lease.ptyId))
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    // A relay PTY cannot move to orcad; its work must finish first.
    blockers.push({
      code: 'orcad_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  blockers.push(
    ...collectUntransferredDependentBlockers(store, createOrcadMigrationManifest(store, target))
  )
  return {
    targetId,
    targetLabel: target.label,
    claimable: !blockers.some(isBlockingOrcadMigrationBlocker),
    blockers
  }
}

/** Confirmed Move anyway can leave saved state, but desktop drafts that cannot be left still block. */
export function leaveBehindClearsOrcadMigrationBlockers(
  store: OrcadMigrationPreflightStore & Pick<Store, 'createOrcadMigrationLeaveBehindView'>,
  targetId: string,
  bridgedPtyIds: readonly string[] = [],
  isBridgedPaneLease?: OrcadMigrationPaneLeasePredicate
): boolean {
  const view = store.createOrcadMigrationLeaveBehindView(targetId)
  const preflight = preflightOrcadMigrationExport(
    {
      ...view,
      getSshTarget: (id) => store.getSshTarget(id),
      getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id)
    },
    targetId,
    undefined,
    bridgedPtyIds
  )
  const target = store.getSshTarget(targetId)
  return (
    preflight.claimable &&
    target !== undefined &&
    preservesOrcadMigrationBridgedPanes(
      createOrcadMigrationManifest(view, target).payload,
      store.getSshRemotePtyLeases(targetId),
      bridgedPtyIds,
      isBridgedPaneLease
    )
  )
}

/** Only saved state blocks: a confirmed "Move anyway" may leave it on this desktop. */
export function onlyLeavableOrcadMigrationBlockers(
  blockers: readonly OrcadMigrationBlocker[]
): boolean {
  const blocking = blockers.filter(isBlockingOrcadMigrationBlocker)
  return (
    blocking.length > 0 &&
    blocking.every((blocker) => blocker.code === 'orcad_migration_dependent_state')
  )
}

export function isBlockingOrcadMigrationBlocker(blocker: OrcadMigrationBlocker): boolean {
  return (
    blocker.category !== 'drainable-static-state' &&
    blocker.code !== 'orcad_migration_saved_port_forwards'
  )
}
