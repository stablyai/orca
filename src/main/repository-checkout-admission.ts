import type { Repo } from '../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { normalizeWindowsWslPath } from '../shared/windows-path-access'
import { awaitWindowsHostGitEnvironmentReady } from './git/runner'
import { getGitRepoRootAsync, inspectGitRepoForRegistrationAsync } from './git/repo'
import { findProjectAtSameRealPath } from './project-realpath-identity'
import { runtimePathsEqual } from './runtime/runtime-worktree-path-identity'
import {
  runtimeRepoIsRegistrationCandidate,
  runtimeRepoMatchesExecutionHost
} from './runtime/runtime-worktree-selection'

export type RepositoryCheckoutAdmission = {
  selectedPath: string
  registrationPath: string
  mainRepoPath?: string | null
  /** The saved row that claimed the selection when it was admitted. */
  saved: Repo | undefined
  /** Re-read after asynchronous work; never retains a deleted or transferred claim. */
  findSaved: () => Repo | undefined
}

/**
 * Which saved rows may claim a selection. Inside the gated WSL scope only this domain's rows do;
 * outside it every caller keeps its existing rule unchanged.
 */
export type SavedClaimRule =
  /** local is this computer's rows, a runtime id that endpoint's, null a path-only caller's. */
  | { scope: 'wsl'; domain: ExecutionHostId | null; aliases: 'lexical' | 'realpath' }
  /** Desktop Add: rows without an SSH connection; realpath only against this computer's rows. */
  | { scope: 'desktop' }
  /** Runtime add: the caller's host rows (every row when it names none). */
  | { scope: 'runtime'; executionHostId: ExecutionHostId | null | undefined }

type Store = { getRepos(): Repo[] }

export async function admitRepositoryCheckout(
  store: Store,
  selectedPath: string,
  kind: 'git' | 'folder',
  rule: SavedClaimRule
): Promise<RepositoryCheckoutAdmission> {
  if (kind === 'git') {
    await awaitWindowsHostGitEnvironmentReady({ cwd: selectedPath })
  }
  const info = kind === 'git' ? await inspectGitRepoForRegistrationAsync(selectedPath) : null
  if (info && !info.isRepo) {
    throw new Error(`Not a valid git repository: ${selectedPath}`)
  }
  const registrationPath = info?.rootPath ?? selectedPath
  if (rule.scope === 'runtime') {
    const candidates = () =>
      store
        .getRepos()
        .filter((repo) => runtimeRepoIsRegistrationCandidate(repo, rule.executionHostId))
    const findAtPath = () =>
      candidates().find(
        (repo) =>
          runtimePathsEqual(repo.path, selectedPath) ||
          runtimePathsEqual(repo.path, registrationPath)
      )
    // Why: git's toplevel is already resolved through symlinks, so an alias of a tracked checkout finds it.
    const saved = findAtPath() ?? (await findProjectAtSameRealPath(candidates(), registrationPath))
    const captured = liveClaim(() => store.getRepos(), saved)
    const findSaved = () => findAtPath() ?? captured()
    return { selectedPath, registrationPath, saved: saved ?? undefined, findSaved }
  }
  const mainRepoPath = info?.mainRepoPath ? await getGitRepoRootAsync(info.mainRepoPath) : null
  const paths = { selectedPath, registrationPath, mainRepoPath }
  const claim =
    rule.scope === 'desktop'
      ? await admitDesktopClaim(store, paths)
      : await admitWslClaim(store, paths, rule)
  return { selectedPath, registrationPath, mainRepoPath, ...claim }
}

type CheckoutPaths = { selectedPath: string; registrationPath: string; mainRepoPath: string | null }
type Claim = Pick<RepositoryCheckoutAdmission, 'saved' | 'findSaved'>

export function findSavedCheckout(
  rows: readonly Repo[],
  paths: CheckoutPaths,
  key = normalizeRuntimePathForComparison
): Repo | undefined {
  const at = (path: string) => rows.find((repo) => key(repo.path) === key(path))
  return (
    at(paths.selectedPath) ??
    at(paths.registrationPath) ??
    rows.find(
      (repo) =>
        paths.mainRepoPath !== null &&
        !isFolderRepo(repo) &&
        key(repo.path) === key(paths.mainRepoPath)
    )
  )
}

function isSshRow(repo: Repo): boolean {
  return parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'ssh'
}

/** A captured claim survives only while the same row is still saved at the same path. */
function liveClaim(
  rows: () => Repo[],
  claim: Repo | null | undefined,
  key = normalizeRuntimePathForComparison
): () => Repo | undefined {
  return () =>
    rows().find(
      (repo) =>
        claim != null &&
        repo.id === claim.id &&
        getRepoExecutionHostId(repo) === getRepoExecutionHostId(claim) &&
        key(repo.path) === key(claim.path)
    )
}

async function admitDesktopClaim(store: Store, paths: CheckoutPaths): Promise<Claim> {
  const key = normalizeRuntimePathForComparison
  const rows = () => store.getRepos().filter((repo) => getRepoRoutingConnectionId(repo) === null)
  const at = (path: string, repo: Repo) => key(repo.path) === key(path)
  const atMain = (repo: Repo) =>
    paths.mainRepoPath !== null && !isFolderRepo(repo) && at(paths.mainRepoPath, repo)
  const saved =
    rows().find((repo) => at(paths.selectedPath, repo)) ??
    rows().find((repo) => at(paths.registrationPath, repo)) ??
    (await findProjectAtSameRealPath(
      store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID),
      paths.registrationPath
    )) ??
    rows().find(atMain)
  const captured = liveClaim(rows, saved)
  return {
    saved: saved ?? undefined,
    findSaved: () =>
      rows().find(
        (repo) => at(paths.selectedPath, repo) || at(paths.registrationPath, repo) || atMain(repo)
      ) ?? captured()
  }
}

async function admitWslClaim(
  store: Store,
  paths: CheckoutPaths,
  rule: Extract<SavedClaimRule, { scope: 'wsl' }>
): Promise<Claim> {
  const key = (path: string) => normalizeRuntimePathForComparison(normalizeWindowsWslPath(path))
  const sameHostRepos = () =>
    store
      .getRepos()
      .filter(
        (repo) =>
          !isSshRow(repo) &&
          (rule.domain === LOCAL_EXECUTION_HOST_ID
            ? getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
            : runtimeRepoMatchesExecutionHost(repo, rule.domain))
      )
  const { mainRepoPath } = paths
  const match = () => findSavedCheckout(sameHostRepos(), paths, key)
  const realPathMatch =
    match() ??
    // Create/nested keep their ordinary catalog lookup free of filesystem reads.
    (rule.aliases === 'lexical'
      ? null
      : ((await findProjectAtSameRealPath(sameHostRepos(), paths.registrationPath, key)) ??
        (mainRepoPath !== null
          ? await findProjectAtSameRealPath(
              sameHostRepos().filter((repo) => !isFolderRepo(repo)),
              mainRepoPath,
              key
            )
          : null)))
  let captured: Repo | null | undefined = realPathMatch
  const findSaved = () => {
    if (captured) {
      return requireSavedProject(store, captured, key)
    }
    captured = match()
    return captured ?? undefined
  }
  return { saved: findSaved(), findSaved }
}

/** Validate a receipt, never discover a replacement for its captured owner and path. */
export function requireSavedProject(
  store: Store,
  claim: Repo,
  key = normalizeRuntimePathForComparison
): Repo {
  const repo = liveClaim(() => store.getRepos(), claim, key)()
  if (!repo) {
    throw new Error('This project changed while it was being added. Try again.')
  }
  return repo
}
