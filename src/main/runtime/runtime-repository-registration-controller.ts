import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { gitExecFileAsync } from '../git/runner'
import { getRepoName } from '../git/repo'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimePathsEqual } from './runtime-worktree-path-identity'
import { runtimeRepoIsRegistrationCandidate } from './runtime-worktree-selection'
import {
  placeProject,
  registrationDomain,
  UNNAMED_REGISTRATION_CALLER,
  type ProjectPlacement,
  type RegistrationCaller
} from '../wsl/project-placement'
import { requireSavedProject } from '../repository-checkout-admission'
import { registerOnWslOwner } from '../wsl/wsl-project-registration'
import { refuseWslHostWindowsDrivePath } from './wsl-host-windows-drive-guard'
import {
  WslHostWindowsDriveRefusalError,
  type WslHostWindowsDriveRefusal
} from '../../shared/wsl-host-windows-drive-refusal'

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
    displayName?: string,
    caller: RegistrationCaller = UNNAMED_REGISTRATION_CALLER
  ): Promise<Repo> {
    const store = this.requireStore()
    if (!isAbsolute(path)) {
      throw new Error('Project path must be an absolute path')
    }
    const placement = await placeProject(store, {
      operation: 'add',
      selectedPath: path,
      kind,
      domain: registrationDomain(caller, executionHostId),
      fromPairedClient: caller.fromPairedClient,
      claimsOutsideWsl: { scope: 'runtime', executionHostId }
    })
    return this.addPlaced(placement, kind, executionHostId, displayName)
  }

  /** The ordinary writer: it reuses the placement's admission and never admits again. */
  async addPlaced(
    placement: ProjectPlacement,
    kind: 'git' | 'folder',
    executionHostId?: ExecutionHostId | null,
    displayName?: string
  ): Promise<Repo> {
    const store = this.requireStore()
    if (placement.kind === 'saved') {
      const existing = requireSavedProject(store, placement.repo)
      return this.reuseExisting(store, existing, executionHostId)
    }
    if (placement.kind === 'wsl') {
      return (
        await registerOnWslOwner(
          placement.authority,
          {
            kind: 'add',
            path: placement.linuxPath,
            repoKind: kind,
            displayName
          },
          placement.admission
        )
      ).repo
    }
    const { admission } = placement
    const repoPath = admission.registrationPath
    // This controller validated/read the path locally; runtime: is the paired-client address, not another machine.
    const detected = await detectRepoIconAndUpstream({
      repoPath,
      kind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    // Another registration of the same checkout can finish while icon discovery is pending.
    const raceWinner = admission.findSaved()
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
    caller: RegistrationCaller = UNNAMED_REGISTRATION_CALLER
  ): Promise<{ repo: Repo } | { error: string; windowsDriveRefusal?: WslHostWindowsDriveRefusal }> {
    const store = this.requireStore()
    const trimmedName = name.trim()
    const trimmedParentPath = parentPath.trim()
    const repoKind: 'git' | 'folder' = kind === 'folder' ? 'folder' : 'git'
    if (!trimmedName) {
      return { error: 'Name cannot be empty' }
    }
    if (/[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..') {
      return { error: 'Name cannot contain slashes or be "." / ".."' }
    }
    if (!trimmedParentPath) {
      return { error: 'Parent directory is required' }
    }
    if (!isAbsolute(trimmedParentPath)) {
      return { error: 'Parent directory must be an absolute path' }
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
    const placement = await placeProject(store, {
      operation: 'create',
      parentPath: trimmedParentPath,
      name: trimmedName,
      domain: registrationDomain(caller),
      fromPairedClient: caller.fromPairedClient,
      // Qualify by host: identical SSH paths name another machine's directory.
      sameTarget: (repo) =>
        runtimeRepoIsRegistrationCandidate(repo) && runtimePathsEqual(repo.path, targetPath)
    })
    if (placement.kind === 'saved') {
      return { repo: requireSavedProject(store, placement.repo) }
    }
    if (placement.kind === 'wsl') {
      const result = await registerOnWslOwner(placement.authority, {
        kind: 'create',
        path: posix.dirname(placement.linuxPath),
        name: trimmedName,
        repoKind
      })
      return { repo: result.repo }
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
          return { error: `"${trimmedName}" already exists at this location and is not a folder.` }
        }
        if ((await readdir(targetPath)).length > 0) {
          return { error: `"${trimmedName}" already exists at this location and is not empty.` }
        }
      } else {
        await mkdir(targetPath, { recursive: false })
        createdDir = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to prepare directory: ${message}` }
    }

    if (repoKind === 'git') {
      const error = await this.initializeGitRepo(targetPath, createdDir)
      if (error) {
        return { error }
      }
    }
    const raceWinner = placement.admission.findSaved()
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

  private async initializeGitRepo(targetPath: string, createdDir: boolean): Promise<string | null> {
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
        await rm(join(targetPath, '.git'), { recursive: true, force: true }).catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return 'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
      }
      const label =
        step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'
      return `${label}: ${message}`
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
