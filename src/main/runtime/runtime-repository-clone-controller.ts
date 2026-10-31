import { randomUUID } from 'node:crypto'
import { refuseWslHostWindowsDrivePath } from './wsl-host-windows-drive-guard'
import { mkdir } from 'node:fs/promises'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { getGitCloneFailureMessage } from '../../shared/git-clone-failure-message'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../git/repo-clone-path'
import { gitSpawnAfterWindowsEnvironmentReady, promptGuardGitEnv } from '../git/runner'
import { reuseSavedCloneTarget } from '../git/saved-clone-target'
import { runWithGitReadCacheInvalidation } from '../git/status'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { getRepoName } from '../git/repo'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimeRepoIsRegistrationCandidate } from './runtime-worktree-selection'
import { resolveClonedFolderConversion } from '../folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../folder-workspace-meta-presence'

type RuntimeRepositoryCloneDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

export class RuntimeRepositoryCloneController {
  private readonly inFlightByPath = new Map<string, Promise<void>>()

  constructor(private readonly deps: RuntimeRepositoryCloneDependencies) {}

  async clone(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = destination.trim()
    if (!trimmedDestination) {
      throw new Error('Clone destination is required')
    }
    const clonePath = deriveValidatedClonePath({ url: trimmedUrl, destination: trimmedDestination })
    await refuseWslHostWindowsDrivePath(trimmedDestination)
    const clonePathKey = getClonePathComparisonKey(clonePath)
    const previous = this.inFlightByPath.get(clonePathKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.inFlightByPath.set(clonePathKey, tail)
    try {
      await previous
      return await runWithGitReadCacheInvalidation(() =>
        this.cloneAfterPathLock(
          trimmedUrl,
          trimmedDestination,
          clonePath,
          clonePathKey,
          executionHostId
        )
      )
    } finally {
      release()
      if (this.inFlightByPath.get(clonePathKey) === tail) {
        this.inFlightByPath.delete(clonePathKey)
      }
    }
  }

  private async cloneAfterPathLock(
    trimmedUrl: string,
    trimmedDestination: string,
    clonePath: string,
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    // Git runs here; an SSH row with the same path refers to another machine.
    const findSaved = (): Repo | undefined =>
      store.getRepos().find((repo) => {
        return (
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoIsRegistrationCandidate(repo, executionHostId)
        )
      })
    const reused = await reuseSavedCloneTarget(findSaved, trimmedUrl, LOCAL_EXECUTION_HOST_ID)
    if (reused) {
      return reused
    }

    await mkdir(trimmedDestination, { recursive: true })
    const claimedTarget = await claimCloneTarget(clonePath)
    let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
    try {
      proc = await gitSpawnAfterWindowsEnvironmentReady(
        ['clone', '--progress', '--', trimmedUrl, clonePath],
        {
          cwd: trimmedDestination,
          // Host Git on purpose: the clone makes a new repo no project owns, even inside one.
          hostGit: true,
          admissionTier: 'interactive',
          env: promptGuardGitEnv(),
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
    } catch (error) {
      await cleanupClaimedCloneTarget(clonePath, claimedTarget)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Clone failed: ${message}`)
    }
    await new Promise<void>((resolve, reject) => {
      let stderrTail = ''
      let settled = false
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096)
      })
      const finish = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (error || code !== 0 || signal) {
          await cleanupClaimedCloneTarget(clonePath, claimedTarget)
        }
        if (error) {
          reject(new Error(`Clone failed: ${error.message}`))
        } else if (signal === 'SIGTERM') {
          reject(new Error('Clone aborted'))
        } else if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`))
        }
      }
      proc.on('error', (error) => void finish(null, null, error))
      proc.on('close', (code, signal) => void finish(code, signal))
    })

    const existing = findSaved()
    if (existing) {
      const conversion = await resolveClonedFolderConversion(store, existing)
      const current = findSaved()
      if (
        current &&
        conversion &&
        findExtraFolderWorkspaceIds(current, store.getAllWorktreeMeta()).length === 0 &&
        current.path === existing.path &&
        isFolderRepo(current) &&
        runtimeRepoIsRegistrationCandidate(current, executionHostId)
      ) {
        const updated = store.updateRepo(current, { kind: 'git', ...conversion })
        if (updated) {
          await prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
          this.invalidate(updated.id)
          return updated
        }
      }
      // Recloning replaced the project root; invalidate cached worktree/authorized-root answers from before it returned.
      if (current) {
        await prepareLocalWorktreeRootForRepo(store, current)
        invalidateAuthorizedRootsCache()
        this.invalidate(current.id)
        return current
      }
    }
    // cloneRepo validated and cloned locally; runtime row stamps do not change where files live.
    const detected = await detectRepoIconAndUpstream({
      repoPath: clonePath,
      kind: 'git',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: clonePath,
      displayName: getRepoName(clonePath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return store.getRepo(repo.id) ?? repo
  }

  private invalidate(repoId: string): void {
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repoId)
    this.deps.notifyReposChanged()
  }
}
