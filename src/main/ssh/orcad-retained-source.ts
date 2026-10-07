/**
 * A converted host's source rows: hidden from this build's lists, which show the managed server
 * instead, and kept for a downgraded build that still reads them. Nothing here ever deletes them;
 * only stopping the server, removing the host or uninstalling does.
 *
 * On every start the rows are compared with what the migration committed. If an older build
 * changed them, the host is marked `sourceChangedAt`: its rows show again, it stays on the relay,
 * and it needs a new move. A second manifest is never merged into the server automatically.
 */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
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
  projectGroupBelongsToOrcadSource,
  repoBelongsToOrcadSource
} from '../persistence/migrating-orcad-catalog/orcad-source-ownership'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/**
 * Whether this build hides the host's source rows: committed to its server and not changed by an
 * older build since. Mid-migration the rows stay shown, since the source is still authoritative,
 * and so does a fence no journal explains (an empty host's deploy): no move owns those rows.
 */
export function isHiddenRetainedSourceTarget(
  userDataPath: string,
  target: Pick<SshTarget, 'id' | 'orcadFence'>
): boolean {
  if (!target.orcadFence || target.orcadFence.sourceChangedAt) {
    return false
  }
  let head: OrcadMigrationSourceCutover | null
  try {
    head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
  } catch {
    return true // An unreadable journal keeps the host fenced, and so hidden.
  }
  return (
    head !== null &&
    (head.phase === 'destination-committed' ||
      head.phase === 'source-retired' ||
      head.destinationEnvironmentId !== target.orcadFence.environmentId)
  )
}

/** `getUserDataPath` is read only once a host is fenced, so unfenced lists never touch the journal. */
export function hiddenRetainedSourceTargetIds(
  getUserDataPath: () => string,
  targets: readonly SshTarget[]
): string[] {
  return targets
    .filter(
      (target) => target.orcadFence && isHiddenRetainedSourceTarget(getUserDataPath(), target)
    )
    .map((target) => target.id)
}

/**
 * A fenced host's `ssh:` session partition is migration source from the fence on: a renderer save
 * would change it mid-conversion, and strip the rows this build hides once it commits.
 */
export function isFrozenOrcadSourceSessionPartition(
  store: Pick<Store, 'getSshTarget'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  const fence = parsed?.kind === 'ssh' ? store.getSshTarget(parsed.targetId)?.orcadFence : undefined
  return fence !== undefined && !fence.sourceChangedAt
}

export function visibleRepos(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): Repo[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const repos = store.getRepos()
  if (hidden.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hidden.some((targetId) => repoBelongsToOrcadSource(repo, targetId))
  )
}

/** Hides only groups the host owns; a local group holding one of its projects stays. */
export function visibleProjectGroups(
  store: Pick<Store, 'getProjectGroups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectGroup[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const groups = store.getProjectGroups()
  if (hidden.length === 0) {
    return groups
  }
  return groups.filter(
    (group) => !hidden.some((targetId) => projectGroupBelongsToOrcadSource(group, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
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

type RetainedSourceVerdict = 'unchanged' | 'changed'

/** Identity only: an older build's edits inside moved projects stay in the retained rows. */
function compareRetainedOrcadSource(
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
      fence.sourceChangedAt
    ) {
      continue
    }
    // A delta move a crash interrupted lost its mark with it; the mark leads back to resuming it.
    const interruptedDelta =
      head.supersedesMigrationId !== undefined &&
      (head.phase === 'source-fenced' || head.phase === 'destination-staged')
    if (
      interruptedDelta ||
      (isRetainedOrcadMigrationSourceCutover(head) &&
        compareRetainedOrcadSource(store, target, head) === 'changed')
    ) {
      store.updateSshTarget(target.id, {
        orcadFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
