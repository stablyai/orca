import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError, readFileViaStream } from '../ssh/ssh-filesystem-stream-reader'
import { uploadBuffer } from '../ssh/sftp-upload'
import type { IFilesystemProvider, FileStat, FileReadResult } from './types'
import type { DirEntry, FsChangeEvent, SearchOptions, SearchResult } from '../../shared/types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'
import type { SFTPWrapper } from 'ssh2'

type SftpFactory = () => Promise<SFTPWrapper>
type WatchRegistration = {
  callbacks: Set<(events: FsChangeEvent[]) => void>
  setupPromise: Promise<void>
}

const WORKSPACE_SPACE_SCAN_TIMEOUT_MS = 130_000

export class SshFilesystemProvider implements IFilesystemProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer
  // Why: each watch() call registers for a specific rootPath, but the relay
  // sends all fs.changed events on one notification channel. Keying by rootPath
  // prevents cross-pollination between different worktree watchers.
  private watchListeners = new Map<string, WatchRegistration>()
  // Why: store the unsubscribe handle so dispose() can detach from the
  // multiplexer. Without this, notification callbacks keep firing after
  // the provider is torn down on disconnect, routing events to stale state.
  private unsubscribeNotifications: (() => void) | null = null
  // Why: relays from a previous build may not implement fs.readFileStream.
  // We log the fallback once per session at warn level so users on stale
  // relays get diagnosed quickly without per-read log spam.
  private loggedStreamFallback = false

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly createSftp?: SftpFactory
  ) {
    this.connectionId = connectionId
    this.mux = mux

    this.unsubscribeNotifications = mux.onNotification((method, params) => {
      if (method === 'fs.changed') {
        const events = params.events as FsChangeEvent[]
        for (const [rootPath, registration] of this.watchListeners) {
          const matching = events.filter((e) => isPathInsideOrEqual(rootPath, e.absolutePath))
          if (matching.length > 0) {
            for (const cb of registration.callbacks) {
              cb(matching)
            }
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
    // Why: streaming is the default path so previews above the legacy single-
    // frame budget (~12 MB after base64) don't hit MAX_MESSAGE_SIZE. Old relays
    // that don't implement fs.readFileStream surface as MethodNotFound; we fall
    // back to the legacy single-shot fs.readFile (which retains the old 10 MB
    // cap on those hosts).
    try {
      return await readFileViaStream(this.mux, filePath)
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        if (!this.loggedStreamFallback) {
          this.loggedStreamFallback = true
          console.warn(
            '[ssh-fs] Relay does not implement fs.readFileStream; falling back to fs.readFile (10 MB cap)'
          )
        }
        return (await this.mux.request('fs.readFile', { filePath })) as FileReadResult
      }
      throw err
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.mux.request('fs.writeFile', { filePath, content })
  }

  async writeFileBase64(filePath: string, contentBase64: string): Promise<void> {
    await this.writeFileBase64Chunk(filePath, contentBase64, false)
  }

  async writeFileBase64Chunk(
    filePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<void> {
    if (!this.createSftp) {
      throw new Error('remote_binary_upload_unavailable')
    }
    const sftp = await this.createSftp()
    try {
      // Why: relay fs.writeFile is text-only. SFTP writes the decoded bytes
      // directly so runtime uploads do not corrupt images, PDFs, or archives.
      await uploadBuffer(sftp, Buffer.from(contentBase64, 'base64'), filePath, {
        append,
        exclusive: !append
      })
    } finally {
      sftp.end()
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    return (await this.mux.request('fs.stat', { filePath })) as FileStat
  }

  async scanWorkspaceSpace(
    rootPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceSpaceDirectoryScanResult> {
    return (await this.mux.request(
      'fs.workspaceSpaceScan',
      { rootPath },
      { signal: options?.signal, timeoutMs: WORKSPACE_SPACE_SCAN_TIMEOUT_MS }
    )) as WorkspaceSpaceDirectoryScanResult
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

  async createDirNoClobber(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDirNoClobber', { dirPath })
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
    let registration = this.watchListeners.get(rootPath)
    if (registration) {
      registration.callbacks.add(callback)
      await registration.setupPromise
      return this.createWatchUnsubscribe(rootPath, registration, callback)
    }

    const callbacks = new Set<(events: FsChangeEvent[]) => void>([callback])
    const setupPromise = this.mux.request('fs.watch', { rootPath }).then(
      () => undefined,
      (error) => {
        if (this.watchListeners.get(rootPath) === registration) {
          this.watchListeners.delete(rootPath)
        }
        throw error
      }
    )
    registration = { callbacks, setupPromise }
    this.watchListeners.set(rootPath, registration)
    await setupPromise

    return this.createWatchUnsubscribe(rootPath, registration, callback)
  }

  private createWatchUnsubscribe(
    rootPath: string,
    registration: WatchRegistration,
    callback: (events: FsChangeEvent[]) => void
  ): () => void {
    return () => {
      registration.callbacks.delete(callback)
      if (registration.callbacks.size === 0 && this.watchListeners.get(rootPath) === registration) {
        this.watchListeners.delete(rootPath)
        this.mux.notify('fs.unwatch', { rootPath })
      }
    }
  }
}
