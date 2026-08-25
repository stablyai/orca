import type { BrowserWindow } from 'electron'
import { getSshFilesystemProviderGeneration } from '../providers/ssh-filesystem-dispatch'
import type { Store } from '../persistence'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  getWorktreeBaseRepoIdentity,
  type WorktreeBaseDirectoryWatchTargetRetry,
  type WorktreeBaseRepoIdentity
} from './worktree-base-directory-watch-target-cache'
import { WorktreeBaseDirectoryWatcherRetryScheduler } from './worktree-base-directory-watcher-retry-scheduler'

export class WorktreeBaseDirectoryWatcherRetries {
  private readonly scheduler = new WorktreeBaseDirectoryWatcherRetryScheduler()
  private readonly desiredTargetVersions = new Map<string, string>()

  constructor(
    private readonly requestSync: (
      store: Store,
      mainWindow: BrowserWindow,
      identities: WorktreeBaseRepoIdentity[]
    ) => void
  ) {}

  private targetVersion(target: WorktreeBaseWatchTarget): string {
    return `${target.providerGeneration ?? 0}\0${target.path}`
  }

  reconcileIntent(
    targets: Map<string, WorktreeBaseWatchTarget>,
    retries: WorktreeBaseDirectoryWatchTargetRetry[],
    store: Store,
    mainWindow: BrowserWindow
  ): void {
    this.desiredTargetVersions.clear()
    const validRetryKeys = new Set<string>()
    for (const target of targets.values()) {
      this.desiredTargetVersions.set(target.key, this.targetVersion(target))
      validRetryKeys.add(`subscribe:${target.key}`)
    }
    for (const retry of retries) {
      validRetryKeys.add(`resolve:${retry.identity.hostId}\0${retry.identity.repoId}`)
    }
    this.scheduler.retainKeys(validRetryKeys)

    for (const retry of retries) {
      const retryKey = `resolve:${retry.identity.hostId}\0${retry.identity.repoId}`
      this.scheduler.schedule(retryKey, retry.version, () => {
        const repoStillExists = store.getRepos().some((repo) => {
          const repoHostId = getRepoExecutionHostId(repo)
          return repo.id === retry.identity.repoId && repoHostId === retry.identity.hostId
        })
        const providerIsCurrent =
          !retry.connectionId ||
          getSshFilesystemProviderGeneration(retry.connectionId) === retry.providerGeneration
        if (!repoStillExists || !providerIsCurrent || mainWindow.isDestroyed()) {
          this.scheduler.clear(retryKey)
          return
        }
        this.requestSync(store, mainWindow, [retry.identity])
      })
    }
  }

  recordSubscriptionResult(
    target: WorktreeBaseWatchTarget,
    result: 'ready' | 'failed' | 'stale',
    store: Store,
    mainWindow: BrowserWindow
  ): void {
    const retryKey = `subscribe:${target.key}`
    if (result === 'ready') {
      this.scheduler.clear(retryKey)
      return
    }
    if (result !== 'failed') {
      return
    }
    const identities = store
      .getRepos()
      .filter((repo) => {
        const identity = getWorktreeBaseRepoIdentity(repo)
        return (
          target.repos.has(repo.id) &&
          (target.connectionId
            ? repo.connectionId === target.connectionId
            : identity.hostId === 'local')
        )
      })
      .map(getWorktreeBaseRepoIdentity)
    const version = this.targetVersion(target)
    this.scheduler.schedule(retryKey, version, () => {
      if (this.desiredTargetVersions.get(target.key) !== version || mainWindow.isDestroyed()) {
        this.scheduler.clear(retryKey)
        return
      }
      this.requestSync(store, mainWindow, identities)
    })
  }

  activate(): void {
    this.scheduler.activate()
  }

  dispose(): void {
    this.scheduler.dispose()
    this.desiredTargetVersions.clear()
  }
}
