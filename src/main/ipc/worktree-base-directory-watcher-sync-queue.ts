import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { WorktreeBaseRepoIdentity } from './worktree-base-directory-watch-target-cache'

export type WorktreeBaseDirectoryWatcherSyncRequest = {
  fullRebuild?: boolean
  dirtyRepoIdentities?: readonly WorktreeBaseRepoIdentity[]
  dirtyConnectionIds?: readonly string[]
}

export type PendingWorktreeBaseDirectoryWatcherSync = {
  store: Store
  mainWindow: BrowserWindow
  fullRebuild: boolean
  dirtyRepoIdentities: Map<string, WorktreeBaseRepoIdentity>
  dirtyConnectionIds: Set<string>
}

type RunSyncPass = (
  request: PendingWorktreeBaseDirectoryWatcherSync,
  signal: AbortSignal
) => Promise<void>

export class WorktreeBaseDirectoryWatcherSyncQueue {
  private scheduledTimer: NodeJS.Timeout | null = null
  private scheduledRequest: PendingWorktreeBaseDirectoryWatcherSync | null = null
  private pendingRequest: PendingWorktreeBaseDirectoryWatcherSync | null = null
  private flight: Promise<void> | null = null
  private activeAbort: AbortController | null = null
  private activeRequest: PendingWorktreeBaseDirectoryWatcherSync | null = null

  constructor(private readonly runPass: RunSyncPass) {}

  private mergeRequest(
    current: PendingWorktreeBaseDirectoryWatcherSync | null,
    store: Store,
    mainWindow: BrowserWindow,
    request: WorktreeBaseDirectoryWatcherSyncRequest | undefined
  ): PendingWorktreeBaseDirectoryWatcherSync {
    const merged = current ?? {
      store,
      mainWindow,
      fullRebuild: false,
      dirtyRepoIdentities: new Map(),
      dirtyConnectionIds: new Set()
    }
    merged.store = store
    merged.mainWindow = mainWindow
    merged.fullRebuild ||= request === undefined || request.fullRebuild === true
    for (const identity of request?.dirtyRepoIdentities ?? []) {
      merged.dirtyRepoIdentities.set(`${identity.hostId}\0${identity.repoId}`, identity)
    }
    for (const connectionId of request?.dirtyConnectionIds ?? []) {
      merged.dirtyConnectionIds.add(connectionId)
    }
    return merged
  }
  private mergeActiveRequest(
    current: PendingWorktreeBaseDirectoryWatcherSync | null
  ): PendingWorktreeBaseDirectoryWatcherSync | null {
    if (!this.activeRequest) {
      return current
    }
    return this.mergeRequest(current, this.activeRequest.store, this.activeRequest.mainWindow, {
      fullRebuild: this.activeRequest.fullRebuild,
      dirtyRepoIdentities: [...this.activeRequest.dirtyRepoIdentities.values()],
      dirtyConnectionIds: [...this.activeRequest.dirtyConnectionIds]
    })
  }

  private ensureFlight(): Promise<void> {
    if (!this.flight) {
      this.flight = (async () => {
        while (this.pendingRequest) {
          const request = this.pendingRequest
          this.pendingRequest = null
          this.activeRequest = request
          const controller = new AbortController()
          this.activeAbort = controller
          try {
            await this.runPass(request, controller.signal)
          } finally {
            if (this.activeRequest === request) {
              this.activeRequest = null
            }
            if (this.activeAbort === controller) {
              this.activeAbort = null
            }
          }
        }
      })().finally(() => {
        this.flight = null
        if (this.pendingRequest) {
          void this.ensureFlight()
        }
      })
    }
    return this.flight
  }

  async sync(
    store: Store,
    mainWindow: BrowserWindow,
    request?: WorktreeBaseDirectoryWatcherSyncRequest
  ): Promise<void> {
    this.pendingRequest = this.mergeActiveRequest(this.pendingRequest)
    this.pendingRequest = this.mergeRequest(this.pendingRequest, store, mainWindow, request)
    this.activeAbort?.abort(new Error('Superseded by a newer worktree watcher synchronization'))
    do {
      await this.ensureFlight()
    } while (this.pendingRequest || this.flight)
  }

  schedule(
    store: Store,
    mainWindow: BrowserWindow,
    request?: WorktreeBaseDirectoryWatcherSyncRequest
  ): void {
    this.scheduledRequest = this.mergeActiveRequest(this.scheduledRequest)
    this.scheduledRequest = this.mergeRequest(this.scheduledRequest, store, mainWindow, request)
    this.activeAbort?.abort(new Error('Superseded by a scheduled worktree watcher synchronization'))
    clearTimeout(this.scheduledTimer ?? undefined)
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null
      const nextRequest = this.scheduledRequest
      this.scheduledRequest = null
      if (!nextRequest || nextRequest.mainWindow.isDestroyed()) {
        return
      }
      void this.sync(nextRequest.store, nextRequest.mainWindow, {
        fullRebuild: nextRequest.fullRebuild,
        dirtyRepoIdentities: [...nextRequest.dirtyRepoIdentities.values()],
        dirtyConnectionIds: [...nextRequest.dirtyConnectionIds]
      })
    }, 100)
  }

  async dispose(): Promise<void> {
    this.pendingRequest = null
    this.scheduledRequest = null
    this.activeAbort?.abort(new Error('Worktree base directory watchers disposed'))
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer)
      this.scheduledTimer = null
    }
    await this.flight
  }
}
