import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import {
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import { resolveDefaultCloneDestination } from '../../shared/git/repo-default-locations'
import type { Repo } from '../../shared/repo-types'
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
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { isFolderRepo } from '../../shared/repo-kind'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { getRepoName } from '../git/repo'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimeRepoMatchesExecutionHost } from './runtime-worktree-selection'
import { cloneRemoteRepo } from '../ipc/repos/remote-repo-clone'

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
    destination: string | undefined,
    executionHostId?: ExecutionHostId | null,
    sshConnectionId?: string
  ): Promise<Repo> {
    if (sshConnectionId) {
      const repo = await cloneRemoteRepo(this.requireStore(), null, {
        connectionId: sshConnectionId,
        url,
        destination: destination ?? ''
      })
      this.invalidate(repo.id)
      return repo
    }
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = (destination ?? '').trim() || this.defaultDestination(store)
    const clonePath = deriveValidatedClonePath({ url: trimmedUrl, destination: trimmedDestination })
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

  private requireStore(): RuntimeStore {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return store
  }

  // Why: mobile callers cannot type host paths; an absent destination resolves to
  // the same default policy the desktop Add Repo clone flow uses.
  private defaultDestination(store: RuntimeStore): string {
    return resolveDefaultCloneDestination({ settings: store.getSettings(), home: homedir() })
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
    // Why: git runs in this process, so an SSH project at the same path string is another machine's.
    const findSaved = (): Repo | undefined =>
      store.getRepos().find((repo) => {
        return (
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoMatchesExecutionHost(repo, executionHostId) &&
          !getRepoSshConnectionId(repo)
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
      if (isFolderRepo(existing)) {
        const updated = store.updateRepo(existing.id, { kind: 'git' })
        if (updated) {
          await prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
          this.invalidate(updated.id)
          return updated
        }
      }
      // Why: git re-created this project's folder, so its worktree root is gone with it and the
      // authorized-roots cache still holds the answers from before the folder came back.
      await prepareLocalWorktreeRootForRepo(store, existing)
      invalidateAuthorizedRootsCache()
      this.invalidate(existing.id)
      return existing
    }
    // `cloneRepo` ran `git clone` in this process (see `assertCloneHostIsSupported`), so the
    // checkout is here regardless of the host id stamped on the row.
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
