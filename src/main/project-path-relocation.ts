import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Repo } from '../shared/repo-types'
import type { ProjectHostSetupUpdateArgs } from '../shared/project-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { RepoWorkspaceIdentityMove } from './persistence/tracking-repos/repo-path-relocation'

/** The store surface a relocation needs; keeps this callable from the IPC and RPC entry points alike. */
export type ProjectPathRelocationStore = {
  getRepos: () => Repo[]
  relocateRepoPath: (
    repoId: string,
    newPath: string,
    hostId?: ExecutionHostId
  ) => { repo: Repo; moves: RepoWorkspaceIdentityMove[] } | null
}

/**
 * Tells the rest of the app an id changed rather than disappeared.
 *
 * Required, not optional: every existing re-key site pairs the persistence write with this signal,
 * because the renderer's worktree diff treats an id that stops appearing as a deletion and tears
 * down the workspace's tabs and terminals. A relocation that only re-keys storage would lose live
 * state that the old outright refusal never touched.
 */
export type WorktreeRenameNotifier = (
  repoId: string,
  oldWorktreeId: string,
  newWorktreeId: string
) => void

export type ProjectPathRelocationResult =
  | { readonly outcome: 'relocated'; readonly repo: Repo }
  | { readonly outcome: 'unchanged'; readonly repo: Repo }
  | { readonly outcome: 'refused'; readonly error: string }

function isExistingDirectory(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory()
  } catch {
    return false
  }
}

/**
 * Move a registered project to the directory it now lives in, keeping its id, its workspaces and
 * their sessions. The single authority for a project path change: `updateRepo` deliberately cannot
 * take `path`, because every workspace id is derived from it.
 *
 * Refuses rather than guesses. A project on an SSH host is checked by the host that runs it, never
 * from here, so a remote relocation is declined outright instead of validated against local disk.
 *
 * Takes the resolved `repo`, not an id: the same id can exist on several execution hosts, and an
 * id-only lookup would relocate a sibling host's row.
 */
export function relocateProjectPath(
  store: ProjectPathRelocationStore,
  repo: Repo,
  rawNewPath: string,
  notifyWorktreeRenamed: WorktreeRenameNotifier,
  options: { directoryExists?: (path: string) => boolean } = {}
): ProjectPathRelocationResult {
  const directoryExists = options.directoryExists ?? isExistingDirectory
  const newPath = rawNewPath.trim()
  if (!newPath || !isAbsolute(newPath)) {
    return { outcome: 'refused', error: 'The new project location must be an absolute path.' }
  }
  if (normalizeRuntimePathForComparison(newPath) === normalizeRuntimePathForComparison(repo.path)) {
    return { outcome: 'unchanged', repo }
  }
  const hostId = getRepoExecutionHostId(repo)
  if (repo.connectionId || hostId !== LOCAL_EXECUTION_HOST_ID) {
    return {
      outcome: 'refused',
      error:
        'Only a project on this machine can be moved from here. Re-import a project that runs on another host from that host.'
    }
  }
  const newPathKey = normalizeRuntimePathForComparison(newPath)
  const occupant = store
    .getRepos()
    .find(
      (candidate) =>
        candidate.id !== repo.id &&
        getRepoExecutionHostId(candidate) === hostId &&
        normalizeRuntimePathForComparison(candidate.path) === newPathKey
    )
  if (occupant) {
    return {
      outcome: 'refused',
      error: `Another project ("${occupant.displayName}") is already registered at ${newPath}.`
    }
  }
  if (!directoryExists(newPath)) {
    return { outcome: 'refused', error: `No directory exists at ${newPath}.` }
  }
  const relocated = store.relocateRepoPath(repo.id, newPath, hostId)
  if (!relocated) {
    return { outcome: 'refused', error: `Project could not be moved: ${repo.id}` }
  }
  for (const move of relocated.moves) {
    notifyWorktreeRenamed(repo.id, move.from, move.to)
  }
  return { outcome: 'relocated', repo: relocated.repo }
}

/**
 * Resolve the path change a setup update asks for before persistence sees it.
 *
 * A repo-backed setup's path is the project's registered path, so changing it is a relocation, not
 * a field write — persistence refuses it outright for exactly that reason. Both the IPC and RPC
 * entry points run this first so a caller reaching either one gets the same answer, and hand the
 * remaining fields on with `path` already applied.
 */
export function applyProjectHostSetupPathRelocation(
  store: ProjectPathRelocationStore & {
    getProjectHostSetups?: () => readonly { id: string; repoId: string; hostId: ExecutionHostId }[]
  },
  args: ProjectHostSetupUpdateArgs,
  notifyWorktreeRenamed: WorktreeRenameNotifier,
  options: { directoryExists?: (path: string) => boolean } = {}
): { updates: ProjectHostSetupUpdateArgs['updates']; relocatedRepo: Repo | null } {
  const requestedPath = args.updates.path
  if (requestedPath === undefined) {
    return { updates: args.updates, relocatedRepo: null }
  }
  const setup = store.getProjectHostSetups?.().find((entry) => entry.id === args.setupId)
  // Resolve the row this setup actually owns. Matching on repo id alone would answer an SSH setup's
  // request with the local checkout, which then passes the local-only guard and moves the wrong one.
  const repo = setup
    ? store
        .getRepos()
        .find(
          (candidate) =>
            candidate.id === setup.repoId && getRepoExecutionHostId(candidate) === setup.hostId
        )
    : undefined
  // An independent setup owns its own `path` field; only a repo-backed one is a project location.
  if (!repo) {
    return { updates: args.updates, relocatedRepo: null }
  }
  const result = relocateProjectPath(store, repo, requestedPath, notifyWorktreeRenamed, options)
  if (result.outcome === 'refused') {
    throw new Error(result.error)
  }
  const { path: _path, ...rest } = args.updates
  return {
    updates: rest,
    relocatedRepo: result.outcome === 'relocated' ? result.repo : null
  }
}
