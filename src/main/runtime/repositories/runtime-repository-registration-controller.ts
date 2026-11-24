import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/repository/appearance/repo-badge-color'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import { initializeNewGitProject } from './new-project-git-initialization'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/command-runner/host-routing/windows-host-git-environment'
import { getRepoName } from '../../git/repositories/repository-name'
import { inspectGitRepoForRegistrationAsync } from '../../git/repositories/discovery/repo-detection'
import {
  getClonePathComparisonKey,
  getSavedProjectPathKeys
} from '../../git/repositories/cloning/repo-clone-path'
import { invalidateAuthorizedRootsCache } from '../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import { findProjectAtSameRealPath } from '../../workspaces/catalog/project-realpath-identity'
import { matchLinkedWorktreeMainCheckout } from '../../workspaces/catalog/linked-worktree-main-checkout'
import { detectRepoLocalMetadata } from '../../repository-icons/repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { runtimePathsEqual } from '../workspaces/catalog/runtime-worktree-path-identity'
import { runtimeRepoIsRegistrationCandidate } from '../workspaces/catalog/runtime-worktree-selection'
import { refuseWslHostWindowsDrivePath } from '../terminal/launch/wsl-host-windows-drive-guard'
import {
  WslHostWindowsDriveRefusalError,
  type WslHostWindowsDriveRefusal
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-windows-drive-refusal'
import { describeWslUncAccessDenied } from '../../wsl/filesystem/wsl-unc-access-denied'
import { getResolvedFolderWorkspacePathStatus } from '../../project-groups/folder-workspace-path-status'
import { runAsWslUserAct, wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import {
  repoCreateFailure,
  type RepoCreateFailure
} from '../../../shared/repository/creation/repo-create-failure-copy'
import { getDefaultCreateProjectParent } from './default-create-project-parent'

type RuntimeRepositoryRegistrationDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

export class RuntimeRepositoryRegistrationController {
  constructor(private readonly deps: RuntimeRepositoryRegistrationDependencies) {}

  async add(
    path: string,
    kind: 'git' | 'folder' = 'git',
    executionHostId?: ExecutionHostId | null,
    displayName?: string
  ): Promise<Repo> {
    const store = this.requireStore()
    if (!isAbsolute(path)) {
      throw new Error('Project path must be an absolute path')
    }
    await refuseWslHostWindowsDrivePath(path)
    if (kind === 'folder') {
      await runAsWslUserAct(wslDistroForPath(path), async () => {
        // This controller serves this filesystem even when a paired client names it runtime:.
        const status = await getResolvedFolderWorkspacePathStatus(
          { folderPath: path },
          LOCAL_EXECUTION_HOST_ID
        )
        if (!status.exists) {
          const accessDenied = await describeWslUncAccessDenied(path, store.getSettings())
          throw new Error(
            accessDenied ??
              (status.reason === 'missing'
                ? `Folder does not exist: ${path}. Choose an existing folder.`
                : status.reason === 'not-directory'
                  ? `Path is not a folder: ${path}. Choose a folder instead.`
                  : `Cannot access folder: ${path}. Check its permissions and try again.`)
          )
        }
      })
    }
    if (kind === 'git') {
      await awaitWindowsHostGitEnvironmentReady({ cwd: path })
    }
    const gitInfo = kind === 'git' ? await inspectGitRepoForRegistrationAsync(path) : null
    if (gitInfo && !gitInfo.isRepo) {
      throw new Error(
        (await describeWslUncAccessDenied(path, store.getSettings())) ??
          `Not a valid git repository: ${path}`
      )
    }
    // Store Git's resolved toplevel; symlink aliases/subfolders hide the main checkout as external.
    const repoPath = gitInfo?.rootPath ?? path
    const sameHostRepos = (): Repo[] =>
      store.getRepos().filter((repo) => runtimeRepoIsRegistrationCandidate(repo, executionHostId))
    // Resolved toplevel lets symlink aliases find existing registrations.
    const findAtPath = (): Repo | undefined =>
      sameHostRepos().find(
        (repo) => runtimePathsEqual(repo.path, path) || runtimePathsEqual(repo.path, repoPath)
      )
    const isMainCheckout = matchLinkedWorktreeMainCheckout(gitInfo)
    const existing =
      findAtPath() ??
      (await findProjectAtSameRealPath(sameHostRepos(), repoPath)) ??
      sameHostRepos().find(isMainCheckout)
    if (existing) {
      return this.reuseExisting(store, existing, executionHostId)
    }
    // This controller validated/read the path locally; runtime: is the paired-client address, not another machine.
    const detected = await detectRepoLocalMetadata({
      repoPath,
      kind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    // A concurrent add of the same folder can finish while the awaits above are pending.
    const raceWinner = findAtPath() ?? sameHostRepos().find(isMainCheckout)
    if (raceWinner) {
      return this.reuseExisting(store, raceWinner, executionHostId)
    }
    const repo: Repo = {
      id: randomUUID(),
      path: repoPath,
      displayName: displayName?.trim() || getRepoName(repoPath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind,
      ...(kind === 'git' ? { externalWorktreeVisibilityLegacy: false } : {})
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    this.invalidate(repo.id)
    return store.getRepo(repo.id) ?? repo
  }

  private reuseExisting(
    store: RuntimeStore,
    existing: Repo,
    executionHostId: ExecutionHostId | null | undefined
  ): Repo {
    if (
      existing.executionHostId == null &&
      parseExecutionHostId(executionHostId)?.kind === 'runtime'
    ) {
      const adopted =
        store.updateRepo(existing, { executionHostId }) ??
        ({ ...existing, executionHostId } as Repo)
      this.invalidate(existing.id)
      return adopted
    }
    return existing
  }

  async create(
    parentPath: string,
    name: string,
    kind: 'git' | 'folder' = 'git',
    folderReplica?: { sourceRepoId: string; displayName: string }
  ): Promise<
    { repo: Repo } | (RepoCreateFailure & { windowsDriveRefusal?: WslHostWindowsDriveRefusal })
  > {
    const store = this.requireStore()
    const folderProjectSourceId = folderReplica?.sourceRepoId
    const trimmedName = name.trim()
    const trimmedParentPath = parentPath.trim()
    const repoKind: 'git' | 'folder' = kind === 'folder' ? 'folder' : 'git'
    if (!trimmedName) {
      return repoCreateFailure('nameEmpty')
    }
    if (/[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..') {
      return repoCreateFailure('nameInvalid')
    }
    if (!trimmedParentPath) {
      return repoCreateFailure('parentRequired')
    }
    if (!isAbsolute(trimmedParentPath)) {
      return repoCreateFailure('parentNotAbsolute')
    }
    try {
      await refuseWslHostWindowsDrivePath(trimmedParentPath)
    } catch (error) {
      // An optional field: older clients read only `error`.
      return error instanceof WslHostWindowsDriveRefusalError
        ? { error: error.message, windowsDriveRefusal: error.data }
        : { error: error instanceof Error ? error.message : String(error) }
    }
    const targetPath = join(trimmedParentPath, trimmedName)
    let targetPathKeys = await getSavedProjectPathKeys(targetPath)
    // Qualify by host: identical SSH paths name another machine's directory.
    const findLocalAtTarget = (): Repo | undefined =>
      store
        .getRepos()
        .find(
          (repo) =>
            runtimeRepoIsRegistrationCandidate(repo) &&
            targetPathKeys.includes(getClonePathComparisonKey(repo.path))
        )
    const existing = findLocalAtTarget()
    if (
      existing &&
      folderProjectSourceId &&
      existing.folderProjectSourceId !== folderProjectSourceId
    ) {
      return repoCreateFailure('targetNotEmpty', { name: trimmedName })
    }
    if (existing) {
      return { repo: existing }
    }

    let createdDir = false
    try {
      await mkdir(trimmedParentPath, { recursive: true })
      const existingStat = await stat(targetPath).catch((error: unknown) => {
        if (isENOENT(error)) {
          return null
        }
        throw error
      })
      if (existingStat) {
        if (!existingStat.isDirectory()) {
          return repoCreateFailure('targetNotFolder', { name: trimmedName })
        }
        if (folderProjectSourceId || (await readdir(targetPath)).length > 0) {
          return repoCreateFailure('targetNotEmpty', { name: trimmedName })
        }
      } else {
        await mkdir(targetPath, { recursive: false })
        createdDir = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return repoCreateFailure('prepareDirectoryFailed', { detail: message })
    }

    if (repoKind === 'git') {
      const failure = await initializeNewGitProject(targetPath, createdDir)
      if (failure) {
        return failure
      }
    }
    targetPathKeys = await getSavedProjectPathKeys(targetPath)
    const raceWinner = findLocalAtTarget()
    if (raceWinner) {
      return folderProjectSourceId && raceWinner.folderProjectSourceId !== folderProjectSourceId
        ? repoCreateFailure('targetNotEmpty', { name: trimmedName })
        : { repo: raceWinner }
    }
    // Register Git's checkout path so the new project stays its own selected checkout.
    const repoPath =
      repoKind === 'git'
        ? (await inspectGitRepoForRegistrationAsync(targetPath)).rootPath
        : targetPath
    const detected = await detectRepoLocalMetadata({
      repoPath,
      kind: repoKind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: repoPath,
      displayName: folderReplica?.displayName ?? trimmedName,
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...detected,
      addedAt: Date.now(),
      kind: repoKind,
      ...(folderProjectSourceId ? { folderProjectSourceId } : {}),
      ...(repoKind === 'git' ? { externalWorktreeVisibilityLegacy: false } : {})
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return { repo: store.getRepo(repo.id) ?? repo }
  }

  /** Read on this host so a paired client suggests this host's Workspace Directory, not its own. */
  defaultCreateParent(): string {
    return getDefaultCreateProjectParent(this.requireStore().getSettings())
  }

  private requireStore(): RuntimeStore {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return store
  }

  private invalidate(repoId: string): void {
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repoId)
    this.deps.notifyReposChanged()
  }
}
