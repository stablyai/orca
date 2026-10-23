/**
 * A converted host's source rows: hidden from this build's lists, which show the managed server
 * instead, and kept for a downgraded build that still reads them. Nothing here ever deletes them;
 * only stopping the server, removing the host or uninstalling does.
 *
 * On every start the rows are compared with what the migrations committed. If they hold a project or
 * folder workspace no move took, as an older build adds, the host is marked `sourceChangedAt`: its
 * rows show again, it is unserved, and it needs a new move. Removing, editing or regrouping rows is
 * never a mark: the server keeps its own copy, and no move could carry it. A second manifest is
 * never merged into the server automatically.
 */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
  MAX_ORCAD_MIGRATION_REPOSITORIES
} from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import {
  isRetainedOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getOrcadSshDeployment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import {
  orcadSourceFolderWorkspaceIds,
  projectGroupBelongsToOrcadSource,
  repoBelongsToOrcadSource
} from '../persistence/migrating-orcad-catalog/orcad-source-ownership'
import {
  findOrcadMigrationSourceCutoverForTarget,
  listOrcadMigrationCutoverChainForTarget,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { orcadMigrationCatalogIds } from './orcad-migration-manifest-export'
import {
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/**
 * Whether this build hides the host's source rows: committed to its server and not changed by an
 * older build since. Mid-migration the rows stay shown, since the source is still authoritative,
 * and so does a fence no journal explains (an empty host's deploy): no move owns those rows.
 */
function isHiddenRetainedSourceTarget(
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
function hiddenRetainedSourceTargetIds(
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
  return reposShownWith(
    store.getRepos(),
    hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  )
}

function reposShownWith(allRepos: Repo[], hiddenTargets: readonly string[]): Repo[] {
  const repos = withoutWslMovedRepos(allRepos)
  if (hiddenTargets.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hiddenTargets.some((targetId) => repoBelongsToOrcadSource(repo, targetId))
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
  const folderWorkspaces = withoutWslMovedFolderWorkspaces(store.getFolderWorkspaces())
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
 * A setup is listed only while its repo row is: the server that took a hidden row lists its own
 * setup under the same id, so leaking ours shows every moved project's host twice (#30859).
 */
export function visibleProjectHostSetups(
  store: CatalogStore & Pick<Store, 'getProjectHostSetups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectHostSetup[] {
  const setups = store.getProjectHostSetups()
  if (setups.length === 0) {
    return setups
  }
  const hiddenTargets = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const allRepos = store.getRepos()
  const shownRepos = reposShownWith(allRepos, hiddenTargets)
  if (hiddenTargets.length === 0 && shownRepos.length === allRepos.length) {
    return setups
  }
  const rowKey = (hostId: string, repoId: string): string => `${hostId}\0${repoId}`
  const shownKeys = new Set(shownRepos.map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id)))
  const hiddenKeys = new Set(
    allRepos
      .map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id))
      .filter((key) => !shownKeys.has(key))
  )
  return setups.filter((setup) => {
    if (setup.repoId && hiddenKeys.has(rowKey(setup.hostId, setup.repoId))) {
      return false
    }
    // Repo-less placeholders have no row to follow, so the hidden host decides for them.
    const host = parseExecutionHostId(setup.hostId)
    return !(host?.kind === 'ssh' && hiddenTargets.includes(host.targetId))
  })
}

/**
 * Identity only, hashed to fit the journal: an older build adding, removing or moving a project is
 * a different fingerprint, a touched timestamp is not. Kept as is: older builds compare it too.
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

type UnmovedOrcadSourceRows = { repositoryIds: string[]; folderWorkspaceIds: string[] }

/**
 * The source's projects and folder workspaces that no move in the chain took or linked, and that
 * keeping the server's version didn't leave behind: all a delta move can add. Groups never count,
 * since deleting or creating one on this desktop is organization, not work the server lacks.
 */
export function unmovedOrcadSourceRows(
  current: OrcadMigrationCatalogPayload,
  chain: readonly OrcadMigrationSourceCutover[]
): UnmovedOrcadSourceRows {
  const moved = orcadMigrationCatalogIds(chain.map((cutover) => cutover.manifest.payload))
  const repositories = new Set([
    ...moved.repositoryIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedRepositoryIds ?? []),
      ...(cutover.keptRepositoryIds ?? [])
    ])
  ])
  const folders = new Set([
    ...moved.folderWorkspaceIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedFolderWorkspaceIds ?? []),
      ...(cutover.keptFolderWorkspaceIds ?? [])
    ])
  ])
  return {
    repositoryIds: current.repositories.map((row) => row.id).filter((id) => !repositories.has(id)),
    folderWorkspaceIds: current.folderWorkspaces
      .map((row) => row.id)
      .filter((id) => !folders.has(id))
  }
}

/** What the retained source must still look like for this build to keep serving it from orcad. */
function retainedOrcadSourceBaseline(head: OrcadMigrationSourceCutover): string {
  return head.sourceBaselineFingerprint ?? orcadCatalogFingerprint(head.manifest.payload)
}

/** The head with `unmoved` recorded as left behind; unchanged past the journal's bounds. */
export function withKeptOrcadSourceRows(
  head: OrcadMigrationSourceCutover,
  unmoved: UnmovedOrcadSourceRows
): OrcadMigrationSourceCutover {
  const keptRepositoryIds = [...(head.keptRepositoryIds ?? []), ...unmoved.repositoryIds]
  const keptFolderWorkspaceIds = [
    ...(head.keptFolderWorkspaceIds ?? []),
    ...unmoved.folderWorkspaceIds
  ]
  // Why: past the bounds, the baseline fingerprint alone records what was kept.
  return keptRepositoryIds.length <= MAX_ORCAD_MIGRATION_REPOSITORIES &&
    keptFolderWorkspaceIds.length <= MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES
    ? { ...head, keptRepositoryIds, keptFolderWorkspaceIds }
    : head
}

type RetainedSourceReview = {
  verdict: 'unchanged' | 'changed'
  /** Unmoved rows the baseline accepts but no kept list names: an older build kept them. */
  unrecordedKeptRows: UnmovedOrcadSourceRows | null
}

/**
 * Changed only when the source holds a row no move took. The fingerprint still has to differ, so
 * the rows an older build's "keep the server's version" left behind, which it never listed, hold.
 */
function reviewRetainedOrcadSource(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>,
  chain: readonly OrcadMigrationSourceCutover[],
  head: OrcadMigrationSourceCutover
): RetainedSourceReview {
  const current = collectOrcadMigrationSourceCatalog(store, target)
  const unmoved = unmovedOrcadSourceRows(current, chain)
  if (unmoved.repositoryIds.length === 0 && unmoved.folderWorkspaceIds.length === 0) {
    return { verdict: 'unchanged', unrecordedKeptRows: null }
  }
  if (orcadCatalogFingerprint(current) !== retainedOrcadSourceBaseline(head)) {
    return { verdict: 'changed', unrecordedKeptRows: null }
  }
  return { verdict: 'unchanged', unrecordedKeptRows: unmoved }
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
    const deployment = getOrcadSshDeployment(environment)
    const target = deployment ? targets.get(deployment.sshTargetId) : undefined
    // Why generation-bound: a host re-created under the same id is a different registration.
    if (target && !target.orcadFence && target.generation === deployment?.sshTargetGeneration) {
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
    const chain = fence ? listOrcadMigrationCutoverChainForTarget(userDataPath, target.id) : []
    const head = chain.at(-1)
    if (!fence || !head || fence.environmentId !== head.destinationEnvironmentId) {
      continue
    }
    // A delta move a crash interrupted lost its mark with it; the mark leads back to resuming it.
    const interruptedDelta =
      head.supersedesMigrationId !== undefined &&
      (head.phase === 'source-fenced' || head.phase === 'destination-staged')
    const review =
      !interruptedDelta && isRetainedOrcadMigrationSourceCutover(head)
        ? reviewRetainedOrcadSource(store, target, chain, head)
        : null
    const kept = review?.unrecordedKeptRows
      ? withKeptOrcadSourceRows(head, review.unrecordedKeptRows)
      : head
    if (kept !== head) {
      // Listed once, so a later group edit, which moves the fingerprint, can't turn them into changes.
      writeOrcadMigrationSourceCutover(userDataPath, kept)
    }
    if (fence.sourceChangedAt) {
      // Earlier builds also marked removed rows and group edits, which no move can carry (#31523).
      if (review?.verdict === 'unchanged') {
        const { sourceChangedAt: _lifted, ...unmarked } = fence
        store.updateSshTarget(target.id, { orcadFence: unmarked })
      }
      continue
    }
    if (interruptedDelta || review?.verdict === 'changed') {
      store.updateSshTarget(target.id, {
        orcadFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
