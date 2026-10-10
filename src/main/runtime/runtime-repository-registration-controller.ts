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
import { getRepoName, isGitRepoAsync } from '../git/repo'
import { invalidateAuthorizedRootsCache, isENOENT } from '../ipc/filesystem-auth'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimePathsEqual } from './runtime-worktree-path-identity'
import { runtimeRepoMatchesExecutionHost } from './runtime-worktree-selection'

type RuntimeRepositoryRegistrationDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

// Why: a trailing space is a legal directory name (Google Drive exports them), so a
// picker-returned parent that exists exactly as requested wins; the trim stays only
// for typed typos. Only a genuinely absent raw spelling may fall back to the trim —
// other probe failures must surface instead of silently relocating the project.
async function resolveCreateParentPathRawFirst(requestedPath: string): Promise<string> {
  const trimmed = requestedPath.trim()
  if (!trimmed || trimmed === requestedPath) {
    return trimmed
  }
  try {
    await stat(requestedPath)
    return requestedPath
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    return trimmed
  }
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
    if (kind === 'git') {
      await awaitWindowsHostGitEnvironmentReady({ cwd: path })
    }
    if (kind === 'git' && !(await isGitRepoAsync(path))) {
      throw new Error(`Not a valid git repository: ${path}`)
    }
    const existing = store.getRepos().find((repo) => {
      return (
        runtimePathsEqual(repo.path, path) && runtimeRepoMatchesExecutionHost(repo, executionHostId)
      )
    })
    if (existing) {
      if (
        existing.executionHostId == null &&
        parseExecutionHostId(executionHostId)?.kind === 'runtime'
      ) {
        const adopted =
          store.updateRepo(existing.id, { executionHostId }) ??
          ({ ...existing, executionHostId } as Repo)
        this.invalidate(existing.id)
        return adopted
      }
      return existing
    }
    // Local on purpose, whatever `executionHostId` stamps on the row: this controller already
    // validated and will read `path` in this process. A `runtime:` stamp is how a paired client
    // addresses the row, not a second machine holding the files.
    const detected = await detectRepoIconAndUpstream({
      repoPath: path,
      kind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path,
      displayName: displayName?.trim() || getRepoName(path),
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

  async create(
    parentPath: string,
    name: string,
    kind: 'git' | 'folder' = 'git'
  ): Promise<{ repo: Repo } | { error: string }> {
    const store = this.requireStore()
    const trimmedName = name.trim()
    let parentDir: string
    try {
      parentDir = await resolveCreateParentPathRawFirst(parentPath)
    } catch (error) {
      // Why: an unexpected probe failure (EACCES...) must not fall back to the trimmed
      // spelling and create the project in a directory the user did not pick.
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Cannot access parent directory: ${message}` }
    }
    const repoKind: 'git' | 'folder' = kind === 'folder' ? 'folder' : 'git'
    if (!trimmedName) {
      return { error: 'Name cannot be empty' }
    }
    if (/[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..') {
      return { error: 'Name cannot contain slashes or be "." / ".."' }
    }
    if (!parentDir) {
      return { error: 'Parent directory is required' }
    }
    if (!isAbsolute(parentDir)) {
      return { error: 'Parent directory must be an absolute path' }
    }
    const targetPath = join(parentDir, trimmedName)
    const existing = store.getRepos().find((repo) => runtimePathsEqual(repo.path, targetPath))
    if (existing) {
      return { repo: existing }
    }

    let createdDir = false
    try {
      await mkdir(parentDir, { recursive: true })
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
    const raceWinner = store.getRepos().find((repo) => runtimePathsEqual(repo.path, targetPath))
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
