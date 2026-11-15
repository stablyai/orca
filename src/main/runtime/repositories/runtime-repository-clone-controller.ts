import { randomUUID } from 'node:crypto'
import { refuseWslHostWindowsDrivePath } from '../terminal/launch/wsl-host-windows-drive-guard'
import { mkdir } from 'node:fs/promises'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/repo-badge-color'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getGitCloneFailureMessage } from '../../../shared/git/remotes/git-clone-failure-message'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey,
  getSavedProjectPathKeys
} from '../../git/repositories/cloning/repo-clone-path'
import { gitSpawnAfterWindowsEnvironmentReady } from '../../git/command-runner/git-spawn'
import { promptGuardGitEnv } from '../../git/command-runner/git-environment/git-process-env'
import { reuseSavedCloneTarget } from '../../git/repositories/cloning/saved-clone-target'
import { checkCloneTarget } from '../../git/repositories/cloning/clone-target-check'
import type {
  CloneTargetArgs,
  CloneTargetCheck
} from '../../../shared/git/clone/clone-target-check'
import { runWithGitReadCacheInvalidation } from '../../git/source-control/git-read-cache-invalidation'
import { invalidateAuthorizedRootsCache } from '../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { detectRepoLocalMetadata } from '../../repository-icons/repo-icon-autodetect'
import { getRepoName } from '../../git/repositories/repository-name'
import { inspectGitRepoForRegistrationAsync } from '../../git/repositories/discovery/repo-detection'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { runtimeRepoIsRegistrationCandidate } from '../workspaces/catalog/runtime-worktree-selection'
import { resolveClonedFolderConversion } from '../../workspaces/catalog/folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../../workspaces/catalog/folder-workspace-meta-presence'

type RuntimeRepositoryCloneDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

// Git runs here; an SSH row with the same path refers to another machine.
function findRegistrationCandidateAt(
  store: RuntimeStore,
  pathKeys: string[],
  executionHostId?: ExecutionHostId | null
): Repo | undefined {
  return store
    .getRepos()
    .find(
      (repo) =>
        pathKeys.includes(getClonePathComparisonKey(repo.path)) &&
        runtimeRepoIsRegistrationCandidate(repo, executionHostId)
    )
}

export class RuntimeRepositoryCloneController {
  private readonly inFlightByPath = new Map<string, Promise<void>>()

  constructor(private readonly deps: RuntimeRepositoryCloneDependencies) {}

  async checkTarget(
    args: CloneTargetArgs,
    executionHostId?: ExecutionHostId | null
  ): Promise<CloneTargetCheck> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return checkCloneTarget(
      { ...args, url: args.url.trim(), destination: args.destination.trim() },
      (pathKeys) => findRegistrationCandidateAt(store, pathKeys, executionHostId),
      LOCAL_EXECUTION_HOST_ID
    )
  }

  async clone(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null,
    folderName?: string
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = destination.trim()
    if (!trimmedDestination) {
      throw new Error('Clone destination is required')
    }
    const clonePath = deriveValidatedClonePath({
      url: trimmedUrl,
      destination: trimmedDestination,
      folderName
    })
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
        this.cloneAfterPathLock(trimmedUrl, trimmedDestination, clonePath, executionHostId)
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
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    let savedPathKeys = await getSavedProjectPathKeys(clonePath)
    const findSaved = (): Repo | undefined =>
      findRegistrationCandidateAt(store, savedPathKeys, executionHostId)
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

    savedPathKeys = await getSavedProjectPathKeys(clonePath)
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
    // Register Git's checkout path so the clone stays its own selected checkout.
    const repoPath = (await inspectGitRepoForRegistrationAsync(clonePath)).rootPath
    const detected = await detectRepoLocalMetadata({
      repoPath,
      kind: 'git',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: repoPath,
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
