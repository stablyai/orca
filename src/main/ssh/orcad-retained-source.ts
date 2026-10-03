/**
 * A converted host's source rows while source retirement is off: hidden from this build's lists,
 * which show the managed server instead, and kept for a downgraded build that still reads them.
 *
 * On every start the rows are compared with what the migration committed. If an older build
 * changed them, the host is marked `sourceChangedAt`: its rows show again, it stays on the relay,
 * and it needs a new move. A second manifest is never merged into the server automatically.
 */
import { createHash } from 'node:crypto'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration-manifest'
import {
  isRetainedOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import {
  orcadSourceFolderWorkspaceIds,
  repoBelongsToOrcadSource
} from '../persistence/migrating-orcad-catalog/orcad-source-ownership'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/** Hosts whose source rows this build hides: fenced, and not changed by an older build since. */
export function hiddenRetainedSourceTargetIds(targets: readonly SshTarget[]): string[] {
  return targets
    .filter((target) => target.orcadFence && !target.orcadFence.sourceChangedAt)
    .map((target) => target.id)
}

export function visibleRepos(store: CatalogStore & Pick<Store, 'getSshTargets'>): Repo[] {
  const hidden = hiddenRetainedSourceTargetIds(store.getSshTargets())
  const repos = store.getRepos()
  if (hidden.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hidden.some((targetId) => repoBelongsToOrcadSource(repo, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(store.getSshTargets())
  const folderWorkspaces = store.getFolderWorkspaces()
  if (hidden.length === 0) {
    return folderWorkspaces
  }
  const state = {
    repos: store.getRepos(),
    projectGroups: store.getProjectGroups(),
    folderWorkspaces
  }
  const hiddenIds = new Set(
    hidden.flatMap((targetId) => [...orcadSourceFolderWorkspaceIds(state, targetId)])
  )
  return folderWorkspaces.filter((workspace) => !hiddenIds.has(workspace.id))
}

/**
 * Identity only, hashed to fit the journal: an older build adding, removing or moving a project is
 * a change, a touched timestamp is not.
 */
export function orcadCatalogFingerprint(catalog: OrcadMigrationCatalogPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        catalog.repositories.map((repo) => `${repo.id}\0${repo.path}`).sort(),
        catalog.folderWorkspaces.map((folder) => `${folder.id}\0${folder.folderPath}`).sort(),
        catalog.projectGroups.map((group) => group.id).sort()
      ])
    )
    .digest('hex')
}

export function currentOrcadSourceFingerprint(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>
): string {
  return orcadCatalogFingerprint(collectOrcadMigrationSourceCatalog(store, target))
}

/** What the retained source must still look like for this build to keep serving it from orcad. */
export function retainedOrcadSourceBaseline(head: OrcadMigrationSourceCutover): string {
  return head.sourceBaselineFingerprint ?? orcadCatalogFingerprint(head.manifest.payload)
}

export type RetainedSourceVerdict = 'unchanged' | 'changed'

export function compareRetainedOrcadSource(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>,
  head: OrcadMigrationSourceCutover
): RetainedSourceVerdict {
  return currentOrcadSourceFingerprint(store, target) === retainedOrcadSourceBaseline(head)
    ? 'unchanged'
    : 'changed'
}

/**
 * Startup pass: restore a fence the profile lost from the registered managed server, and mark a
 * retained host whose rows an older build changed. Never throws; a failed pass changes nothing.
 */
export function reconcileManagedOrcadSshTargets(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date = () => new Date()
): void {
  try {
    restoreFencesFromManagedServers(userDataPath, store)
    markChangedRetainedSources(userDataPath, store, now)
  } catch (error) {
    console.warn('[ssh] Could not reconcile managed Orca server hosts:', error)
  }
}

function restoreFencesFromManagedServers(userDataPath: string, store: TargetStore): void {
  const targets = new Map(store.getSshTargets().map((target) => [target.id, target]))
  for (const environment of listEnvironments(userDataPath)) {
    const targetId = environment.orcadDeployment?.sshTargetId
    const target = targetId ? targets.get(targetId) : undefined
    // Why generation-bound: a host re-created under the same id is a different registration.
    if (
      target &&
      !target.orcadFence &&
      target.generation === environment.orcadDeployment?.sshTargetGeneration
    ) {
      store.updateSshTarget(target.id, { orcadFence: { environmentId: environment.id } })
    }
  }
}

function markChangedRetainedSources(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date
): void {
  for (const target of store.getSshTargets()) {
    const fence = target.orcadFence
    const head = fence ? findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id) : null
    if (
      !fence ||
      !head ||
      fence.environmentId !== head.destinationEnvironmentId ||
      fence.sourceChangedAt ||
      !isRetainedOrcadMigrationSourceCutover(head)
    ) {
      continue
    }
    if (compareRetainedOrcadSource(store, target, head) === 'changed') {
      store.updateSshTarget(target.id, {
        orcadFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
