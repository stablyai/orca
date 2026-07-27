import {
  getProjectHostSetupForRepo,
  getProjectIdentityKey,
  isGitHubBackedRepo
} from '../shared/project-host-setup-projection'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupResult,
  Repo,
  RepoProjectHostSetupMethod,
  WorktreeMeta
} from '../shared/types'
import { remapWorktreeMetaToRepoProject } from './project-identity-repair-worktree-meta'
import {
  isSameRemoteIdentity,
  isSameUpstream,
  matchesProject,
  projectRemoteMatch,
  type ProjectRemoteMatch
} from './project-remote-identity-match'
import { probeGitRemoteIdentity, type GitRemoteIdentityProbe } from './repo-git-remote-identity'

/** The import dialog has a 15s runtime RPC budget and the local/SSH IPC invoke has
 *  none, so an unreachable host must fail the probe long before either gives up. */
export const EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS = 3000

export const PROJECT_IDENTITY_MISMATCH_MESSAGE =
  'Imported folder does not match the selected project identity.'
export const PROJECT_IDENTITY_UNRESOLVED_MESSAGE =
  "The selected project has no resolved remote identity yet. Open its existing host so Orca can read that repository's remote, then try again."
export const REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE =
  'This folder is already linked to a GitHub repository, so it cannot join a non-GitHub project.'
export const PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE =
  "Orca could not read this folder's git remote from its host, so it cannot confirm the folder belongs to the selected project. Open the folder on its own host and try again."

export type ExistingFolderReconciliationStore = {
  getProjects(): Project[]
  getProjectHostSetups(): ProjectHostSetup[]
  getRepo(id: string): Repo | undefined
  updateRepo(
    id: string,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity' | 'upstream' | 'projectHostSetupMethod'>
  ): Repo | null
  /** Rollback-only: key presence restores a field, `undefined` restores it to absent.
   *  `updateRepo` cannot express that, and widening it for one rollback would change
   *  patch semantics for every caller. */
  restoreRepoIdentityFields(
    id: string,
    restore: Pick<Partial<Repo>, 'upstream' | 'gitRemoteIdentity'>
  ): Repo | null
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): unknown
}

/** Carries whether a rejected import left a store mutation behind, so callers know
 *  whether their refresh notification is still required. */
class ExistingFolderReconciliationError extends Error {
  readonly storeChanged: boolean

  constructor(message: string, storeChanged: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExistingFolderReconciliationError'
    this.storeChanged = storeChanged
  }
}

/** True when a rejected reconciliation mutated the store, so its caller must still
 *  notify — the write, its rollback, and the compatibility-state resync are all real
 *  changes that a renderer holding the pre-import record cannot see otherwise. */
export function didReconciliationChangeStore(error: unknown): boolean {
  return error instanceof ExistingFolderReconciliationError && error.storeChanged
}

export type ExistingFolderReconciliationArgs = {
  store: ExistingFolderReconciliationStore
  /** The record the add/import path returned; its `kind` and host win over request hints. */
  repo: Repo
  projectId: string
  setupMethod?: RepoProjectHostSetupMethod
  /** The one execution host this process can run git on; anything else is unprobeable. */
  ownedExecutionHostId: ExecutionHostId
}

type RepoIdentityUpdates = Pick<Repo, 'gitRemoteIdentity' | 'upstream'>
type RepoIdentitySnapshot = Pick<Partial<Repo>, 'gitRemoteIdentity' | 'upstream'>

function buildProjectHostSetupResult(
  store: Pick<ExistingFolderReconciliationStore, 'getProjects' | 'getProjectHostSetups'>,
  repo: Repo
): ProjectHostSetupResult {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  const project = store.getProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}

async function probeOwnedRepoRemotes(
  repo: Repo,
  ownedExecutionHostId: ExecutionHostId
): Promise<GitRemoteIdentityProbe> {
  const hostId = getRepoExecutionHostId(repo)
  // A record owned by another host says nothing about this one, and probing it
  // locally would run git against a path that does not exist here.
  if (hostId !== ownedExecutionHostId) {
    return { status: 'unavailable' }
  }
  // Route to the connection named by the host id we just authorized, not to
  // `repo.connectionId`: on a record whose two fields disagree, the latter would run
  // git on a different machine than the one this probe was cleared for.
  const parsed = parseExecutionHostId(hostId)
  const connectionId = parsed?.kind === 'ssh' ? parsed.targetId : null
  return await probeGitRemoteIdentity(repo.path, connectionId, {
    timeoutMs: EXISTING_FOLDER_REMOTE_PROBE_TIMEOUT_MS
  })
}

function planRemoteIdentityUpdate(
  repo: Repo,
  probe: GitRemoteIdentityProbe,
  match: ProjectRemoteMatch
): RepoIdentityUpdates {
  if (probe.status === 'resolved') {
    const matched = probe.remotes.find((remote) => matchesProject(remote, match))
    if (!matched) {
      throw new Error(PROJECT_IDENTITY_MISMATCH_MESSAGE)
    }
    // Persist the matching remote, not the primary: a fork checkout's primary is
    // `upstream`, which would land the repo in a third project.
    return isSameRemoteIdentity(repo.gitRemoteIdentity, matched)
      ? {}
      : { gitRemoteIdentity: matched }
  }
  // Never clear a stale non-null identity with the settled `null` marker: that demotes
  // the repo to `repo:<repoId>` and drops it out of its current project for nothing.
  if (
    probe.status === 'no-remote' &&
    repo.gitRemoteIdentity !== null &&
    getProjectIdentityKey(repo).startsWith('repo:')
  ) {
    return { gitRemoteIdentity: null }
  }
  return {}
}

function requireProjectRemoteMatch(
  store: Pick<ExistingFolderReconciliationStore, 'getProjects'>,
  projectId: string
): { project: Project; match: ProjectRemoteMatch } {
  const project = store.getProjects().find((entry) => entry.id === projectId)
  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }
  const match = projectRemoteMatch(project)
  if (match.identityKey === null) {
    throw new Error(PROJECT_IDENTITY_UNRESOLVED_MESSAGE)
  }
  return { project, match }
}

/** The fallback stamps the project's identity without a positive remote match, so it must
 *  not run over a settled remote that names somewhere else: a git Orca could not read is
 *  no evidence the folder belongs here. Only repos with no usable identity of their own —
 *  pending, `repo:`-keyed, or the settled no-remote marker — can be linked blind. */
function mayStampProjectIdentity(
  identity: Repo['gitRemoteIdentity'],
  probe: GitRemoteIdentityProbe,
  match: ProjectRemoteMatch
): boolean {
  if (probe.status === 'resolved') {
    // A resolved probe already matched (§4 rejected the rest), so its remote is the evidence.
    return true
  }
  return !identity || matchesProject(identity, match)
}

/** Decides accept/reject without touching the store, so a rejected import writes nothing.
 *  Runs against the record the store holds now, not the one the add path handed back. */
function planIdentityUpdates(args: {
  repo: Repo
  projectId: string
  project: Project
  match: ProjectRemoteMatch
  probe: GitRemoteIdentityProbe
}): RepoIdentityUpdates {
  const { repo, projectId, project, match, probe } = args
  const updates = planRemoteIdentityUpdate(repo, probe, match)
  const planned = { ...repo, ...updates }
  if (getProjectIdentityKey(planned) === projectId) {
    return updates
  }

  // The same remote can land in different namespaces when only one side carries
  // GitHub metadata; stamping the selected project's identity closes that gap.
  const providerIdentity = project.providerIdentity
  if (
    providerIdentity?.provider === 'github' &&
    mayStampProjectIdentity(planned.gitRemoteIdentity, probe, match)
  ) {
    const withUpstream: RepoIdentityUpdates = {
      ...updates,
      upstream: {
        owner: providerIdentity.owner,
        repo: providerIdentity.repo,
        ...(providerIdentity.host ? { host: providerIdentity.host } : {})
      }
    }
    if (getProjectIdentityKey({ ...repo, ...withUpstream }) !== projectId) {
      throw new Error(PROJECT_IDENTITY_MISMATCH_MESSAGE)
    }
    return withUpstream
  }
  // Generic git projects never synthesize identity, and clearing the repo's GitHub
  // metadata to force a match would re-key it out of its real project.
  throw new Error(rejectionMessage(repo, updates, probe))
}

function rejectionMessage(
  repo: Repo,
  updates: RepoIdentityUpdates,
  probe: GitRemoteIdentityProbe
): string {
  if (isGitHubBackedRepo({ ...repo, ...updates })) {
    return REPO_GITHUB_METADATA_OUTRANKS_PROJECT_MESSAGE
  }
  // An unread remote is not a mismatch: a repo owned by another host, or one whose probe
  // failed, was never compared against anything. Saying "does not match" blames a folder
  // Orca never looked at and leaves the user with nothing to act on.
  if (probe.status === 'unavailable' && !isFolderRepo(repo)) {
    return PROJECT_IDENTITY_REMOTE_UNREADABLE_MESSAGE
  }
  return PROJECT_IDENTITY_MISMATCH_MESSAGE
}

/** A rejected import must not leave its identity writes behind (§7): the refresh itself
 *  can re-project the repo out of the project it was already in. Restores the exact
 *  pre-write snapshot of both identity fields — including back to absent, which is a
 *  different state from the `null` markers (a `null` upstream is terminal for the fork
 *  backfill, a `null` identity falsely settles "this folder has no remote"). Nothing is
 *  written when the record already matches the snapshot, so a write the store dropped
 *  costs no second mutation. */
function revertIdentityWrites(
  store: ExistingFolderReconciliationStore,
  repoId: string,
  previous: RepoIdentitySnapshot,
  current: Repo
): void {
  const restore: RepoIdentitySnapshot = {}
  if (!isSameUpstream(current.upstream, previous.upstream)) {
    restore.upstream = previous.upstream
  }
  if (!isSameRemoteIdentity(current.gitRemoteIdentity, previous.gitRemoteIdentity)) {
    restore.gitRemoteIdentity = previous.gitRemoteIdentity
  }
  if (!('upstream' in restore) && !('gitRemoteIdentity' in restore)) {
    return
  }
  store.restoreRepoIdentityFields(repoId, restore)
}

/** True when reconciliation actually rewrote the repo's identity fields. Callers that
 *  already broadcast for the add itself use this to skip a second full-list refresh. */
export function didReconciliationChangeRepoIdentity(before: Repo, after: Repo): boolean {
  return (
    !isSameUpstream(before.upstream, after.upstream) ||
    !isSameRemoteIdentity(before.gitRemoteIdentity, after.gitRemoteIdentity)
  )
}

/** Every read and write below races a user deleting the project, so each one has to say
 *  which step lost the record. */
function requireLiveRepo(repo: Repo | null | undefined, repoId: string, stage: string): Repo {
  if (!repo) {
    throw new Error(`Project setup repo disappeared before ${stage}: ${repoId}`)
  }
  return repo
}

/** The identity fields as they stood before the write, with an absent field left as an
 *  absent key so the rollback can tell "never set" from the `null` markers. */
function snapshotIdentityFields(repo: Repo): RepoIdentitySnapshot {
  return {
    ...(repo.upstream !== undefined ? { upstream: repo.upstream } : {}),
    ...(repo.gitRemoteIdentity !== undefined ? { gitRemoteIdentity: repo.gitRemoteIdentity } : {})
  }
}

/**
 * Single identity policy for "add this existing folder to the selected project",
 * shared by local IPC, SSH IPC, and runtime-host setup. Acceptance is decided from
 * the folder's current canonical remotes, never from projected project ids alone.
 */
export async function reconcileExistingFolderProjectIdentity(
  args: ExistingFolderReconciliationArgs
): Promise<ProjectHostSetupResult> {
  // Every rejection leaves through `ExistingFolderReconciliationError` so callers never
  // have to infer from the message whether the store was touched before the throw.
  const progress = { storeChanged: false }
  try {
    return await reconcileWithinStore(args, progress)
  } catch (error) {
    if (error instanceof ExistingFolderReconciliationError) {
      throw error
    }
    throw new ExistingFolderReconciliationError(
      error instanceof Error ? error.message : String(error),
      progress.storeChanged,
      { cause: error }
    )
  }
}

async function reconcileWithinStore(
  args: ExistingFolderReconciliationArgs,
  progress: { storeChanged: boolean }
): Promise<ProjectHostSetupResult> {
  const { store, projectId } = args
  let repo = args.repo
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  if (setup.projectId !== projectId) {
    const { project, match } = requireProjectRemoteMatch(store, projectId)
    // Probe from the record the add path returned: its `kind` and execution host are what
    // the ownership check authorized.
    const probe: GitRemoteIdentityProbe = isFolderRepo(repo)
      ? { status: 'unavailable' }
      : await probeOwnedRepoRemotes(repo, args.ownedExecutionHostId)
    // Plan and snapshot from the store, not from `args.repo`: the probe above is the one
    // `await` in this function, and background identity enrichment can land inside it.
    // Planning against a stale view would either discard that write on rollback or
    // conclude "already matching" while the store is still behind.
    const linkStage = 'it could be linked'
    const live = requireLiveRepo(store.getRepo(repo.id), repo.id, linkStage)
    const previous = snapshotIdentityFields(live)
    const updates = planIdentityUpdates({ repo: live, projectId, project, match, probe })
    repo = live
    const wroteIdentity = Object.keys(updates).length > 0
    if (wroteIdentity) {
      progress.storeChanged = true
      repo = requireLiveRepo(store.updateRepo(repo.id, updates), repo.id, linkStage)
    }
    // The plan predicts from an in-memory record; only the store knows what its
    // sanitizers kept and what a concurrent writer changed underneath it.
    if (getProjectHostSetupForRepo(store.getProjectHostSetups(), repo).projectId !== projectId) {
      // Only a write can need reverting: with none, the store holds nothing this flow put
      // there, and writing over its own fields would be a mutation nothing announces.
      if (wroteIdentity) {
        revertIdentityWrites(store, repo.id, previous, repo)
      }
      throw new Error(PROJECT_IDENTITY_MISMATCH_MESSAGE)
    }
    // The repo just moved projects, so meta stamped from the old projection has to follow
    // it before this flow's caller notifies.
    remapWorktreeMetaToRepoProject(store, repo)
  }
  // Only a reconciled repo is marked as an imported/cloned setup for this project.
  progress.storeChanged = true
  const updated = store.updateRepo(repo.id, {
    projectHostSetupMethod: args.setupMethod ?? 'imported-existing-folder'
  })
  return buildProjectHostSetupResult(
    store,
    requireLiveRepo(updated, repo.id, 'setup metadata could be linked')
  )
}
