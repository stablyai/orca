import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { gitExecFileAsync, awaitWindowsHostGitEnvironmentReady } from '../git/runner'
import { getRepoName, inspectGitRepoForRegistrationAsync } from '../git/repo'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { findProjectAtSameRealPath } from '../project-realpath-identity'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimePathsEqual } from './runtime-worktree-path-identity'
import { runtimeRepoIsRegistrationCandidate } from './runtime-worktree-selection'
import { refuseWslHostWindowsDrivePath } from './wsl-host-windows-drive-guard'
import {
  WslHostWindowsDriveRefusalError,
  type WslHostWindowsDriveRefusal
} from '../../shared/wsl-host-windows-drive-refusal'
import { describeWslUncAccessDenied } from '../wsl/wsl-unc-access-denied'
import { repoCreateFailure, type RepoCreateFailure } from '../../shared/repo-create-failure-copy'

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
    if (kind === 'git') {
      await awaitWindowsHostGitEnvironmentReady({ cwd: path })
    }
    const gitInfo = kind === 'git' ? await inspectGitRepoForRegistrationAsync(path) : null
    if (gitInfo && !gitInfo.isRepo) {
      throw new Error(
        (await describeWslUncAccessDenied(path)) ?? `Not a valid git repository: ${path}`
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
    const existing = findAtPath() ?? (await findProjectAtSameRealPath(sameHostRepos(), repoPath))
    if (existing) {
      return this.reuseExisting(store, existing, executionHostId)
    }
    // This controller validated/read the path locally; runtime: is the paired-client address, not another machine.
    const detected = await detectRepoIconAndUpstream({
      repoPath,
      kind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    // A concurrent add of the same folder can finish while the awaits above are pending.
    const raceWinner = findAtPath()
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
    kind: 'git' | 'folder' = 'git'
  ): Promise<
    { repo: Repo } | (RepoCreateFailure & { windowsDriveRefusal?: WslHostWindowsDriveRefusal })
  > {
    const store = this.requireStore()
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
    // Qualify by host: identical SSH paths name another machine's directory.
    const findLocalAtTarget = (): Repo | undefined =>
      store
        .getRepos()
        .find(
          (repo) =>
            runtimeRepoIsRegistrationCandidate(repo) && runtimePathsEqual(repo.path, targetPath)
        )
    const existing = findLocalAtTarget()
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
        if ((await readdir(targetPath)).length > 0) {
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
      const failure = await this.initializeGitRepo(targetPath, createdDir)
      if (failure) {
        return failure
      }
    }
    const raceWinner = findLocalAtTarget()
    if (raceWinner) {
      return { repo: raceWinner }
    }
    const detected = await detectRepoIconAndUpstream({
      repoPath: targetPath,
      kind: repoKind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: targetPath,
      displayName: trimmedName,
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...detected,
      addedAt: Date.now(),
      kind: repoKind,
      ...(repoKind === 'git' ? { externalWorktreeVisibilityLegacy: false } : {})
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return { repo: store.getRepo(repo.id) ?? repo }
  }

  private async initializeGitRepo(
    targetPath: string,
    createdDir: boolean
  ): Promise<RepoCreateFailure | null> {
    let step: 'init' | 'commit' = 'init'
    try {
      await gitExecFileAsync(['init'], { cwd: targetPath })
      step = 'commit'
      await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
        cwd: targetPath
      })
      return null
    } catch (error) {
      if (createdDir) {
        await rm(targetPath, { recursive: true, force: true }).catch(() => {})
      } else if (step === 'commit') {
        await rm(join(targetPath, '.git'), {
          recursive: true,
          force: true
        }).catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return repoCreateFailure('gitIdentityMissing')
      }
      return repoCreateFailure(step === 'init' ? 'gitInitFailed' : 'initialCommitFailed', {
        detail: message
      })
    }
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
