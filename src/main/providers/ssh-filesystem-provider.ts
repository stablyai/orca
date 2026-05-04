import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IFilesystemProvider, FileStat, FileReadResult } from './types'
import type { DirEntry, FsChangeEvent, SearchOptions, SearchResult } from '../../shared/types'

export class SshFilesystemProvider implements IFilesystemProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer
  // Why: each watch() call registers for a specific rootPath, but the relay
  // sends all fs.changed events on one notification channel. Keying by rootPath
  // prevents cross-pollination between different worktree watchers.
  private watchListeners = new Map<string, (events: FsChangeEvent[]) => void>()
  // Why: store the unsubscribe handle so dispose() can detach from the
  // multiplexer. Without this, notification callbacks keep firing after
  // the provider is torn down on disconnect, routing events to stale state.
  private unsubscribeNotifications: (() => void) | null = null

  constructor(connectionId: string, mux: SshChannelMultiplexer) {
    this.connectionId = connectionId
    this.mux = mux

    this.unsubscribeNotifications = mux.onNotification((method, params) => {
      if (method === 'fs.changed') {
        const events = params.events as FsChangeEvent[]
        for (const [rootPath, cb] of this.watchListeners) {
          const matching = events.filter((e) => e.absolutePath.startsWith(rootPath))
          if (matching.length > 0) {
            cb(matching)
          }
        }
      }
    })
  }

  dispose(): void {
    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications()
      this.unsubscribeNotifications = null
    }
    this.watchListeners.clear()
  }

  getConnectionId(): string {
    return this.connectionId
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    return (await this.mux.request('fs.readDir', { dirPath })) as DirEntry[]
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    return (await this.mux.request('fs.readFile', { filePath })) as FileReadResult
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.mux.request('fs.writeFile', { filePath, content })
  }

  async stat(filePath: string): Promise<FileStat> {
    return (await this.mux.request('fs.stat', { filePath })) as FileStat
  }

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    await this.mux.request('fs.deletePath', { targetPath, recursive })
  }

  async createFile(filePath: string): Promise<void> {
    await this.mux.request('fs.createFile', { filePath })
  }

  async createDir(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDir', { dirPath })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.mux.request('fs.rename', { oldPath, newPath })
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.mux.request('fs.copy', { source, destination })
  }

  async realpath(filePath: string): Promise<string> {
    return (await this.mux.request('fs.realpath', { filePath })) as string
  }

  async search(opts: SearchOptions): Promise<SearchResult> {
    return (await this.mux.request('fs.search', opts)) as SearchResult
  }

  async listFiles(rootPath: string, options?: { excludePaths?: string[] }): Promise<string[]> {
    // Why: older relays ignore unknown fields, so sending excludePaths to a
    // pre-refactor relay is a non-regression. The relay validates the shape
    // and treats malformed input as "no exclusions" rather than failing.
    const params: Record<string, unknown> = { rootPath }
    if (options?.excludePaths && options.excludePaths.length > 0) {
      params.excludePaths = options.excludePaths
    }
    return (await this.mux.request('fs.listFiles', params)) as string[]
  }

  async watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void> {
    this.watchListeners.set(rootPath, callback)
    await this.mux.request('fs.watch', { rootPath })

    return () => {
      this.watchListeners.delete(rootPath)
      // Why: each watch() starts a @parcel/watcher on the relay for this specific
      // rootPath. We must always notify the relay to stop it, not only when all
      // watchers are gone — otherwise the remote watcher leaks inotify descriptors.
      this.mux.notify('fs.unwatch', { rootPath })
    }
  }
}
