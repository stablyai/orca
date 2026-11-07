import {
  getRuntimeFileWatcherLeases,
  registerRuntimeFileWatcherRelease
} from './file-watcher-leases'
import {
  requireLocalRuntimeFileRoute,
  requireRuntimeFileProvider,
  runtimeFileSshTargetId,
  resolveFileExplorerPath
} from '../file-target'
import type { RuntimeFileCommandHost } from '../file-command-host'
import { stat } from 'node:fs/promises'
import type { DirEntry, FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import {
  PATH_ACCESS_DENIED_MESSAGE,
  resolveAuthorizedPath
} from '../../../ipc/filesystem/access/filesystem-auth'
import { resolveRuntimeAuthorizedPath } from '../chat-scratch-file-root'
import { WindowsRuntimeWatchPool } from './windows-runtime-watch-pool'
import { beginWatcherInstall } from '../../../workspaces/removal/watcher-removal-gate'
import {
  closeFileExplorerWatcherInWatcherProcess,
  watchFileExplorerInWatcherProcess
} from '../../file-watcher-host'

type RuntimeFileWatchHost = Pick<
  RuntimeFileCommandHost,
  'getRuntimeId' | 'requireStore' | 'resolveRuntimeFileTarget'
>

export class RuntimeFileWatches {
  private readonly windowsWatches = new WindowsRuntimeWatchPool()

  constructor(private readonly host: RuntimeFileWatchHost) {}

  async readFileExplorerDir(
    worktreeSelector: string,
    relativePath: string,
    options: { followSymlinks?: boolean } = {}
  ): Promise<DirEntry[]> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    // Providers do not guarantee directory ordering.
    return sortDirEntries(
      await requireRuntimeFileProvider(target, this.host).readDir(target.path, options)
    )
  }

  async watchFileExplorer(
    worktreeSelector: string,
    callback: (events: FsChangeEvent[]) => void,
    onTerminalError: (error: Error) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<() => Promise<void>> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, '')
    // Reject runtime-host namespace mismatches before registering watcher leases.
    const sshTargetId = runtimeFileSshTargetId(target)
    const open = async (): Promise<{
      unsubscribe: () => Promise<void>
      rootPaths: string[]
    }> => {
      const finishInstall = beginWatcherInstall(target.path, sshTargetId)
      try {
        requireLocalRuntimeFileRoute(target)
        const rootPath = await resolveRuntimeAuthorizedPath(target.path, this.host.requireStore())
        const rootStats = await stat(rootPath)
        if (!rootStats.isDirectory()) {
          throw new Error('not_a_directory')
        }
        if (process.platform === 'win32') {
          const close = await this.windowsWatches.watch(rootPath, callback, onTerminalError, signal)
          return { unsubscribe: close, rootPaths: [target.path, rootPath] }
        }
        // #5308/#8212: isolate native faults and blocking crawls from main/serve.
        const dispose = await watchFileExplorerInWatcherProcess(
          rootPath,
          callback,
          onTerminalError,
          signal
        )
        return { unsubscribe: dispose, rootPaths: [target.path, rootPath] }
      } finally {
        finishInstall()
      }
    }
    const initial = await open()
    return registerRuntimeFileWatcherRelease(
      this.host.getRuntimeId(),
      sshTargetId,
      initial.rootPaths,
      initial.unsubscribe,
      async () => (await open()).unsubscribe,
      onTerminalError
    )
  }

  async closeFileExplorerWatchersForPath(rootPath: string, connectionId?: string): Promise<void> {
    const leases = getRuntimeFileWatcherLeases(this.host.getRuntimeId(), connectionId, rootPath)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.suspend()))
    }
    // Windows watches in-process, so only the leases above exist; Git may already have revoked the path.
    if (!connectionId && process.platform !== 'win32') {
      const resolvedRootPath = await this.resolveRemovalTeardownPath(rootPath)
      if (resolvedRootPath !== null) {
        await closeFileExplorerWatcherInWatcherProcess(resolvedRootPath)
      }
    }
  }

  /** A denied path cannot hold a watcher — installs authorize first, and removal may
   *  already have unregistered this worktree in Git (#37902). Failing here would fail
   *  the whole removal after Git succeeded, and outside roots read as "not authorized". */
  private async resolveRemovalTeardownPath(rootPath: string): Promise<string | null> {
    try {
      // Failed setup may still own a child without having published a lease-release callback.
      return await resolveAuthorizedPath(rootPath, this.host.requireStore())
    } catch (error) {
      if (error instanceof Error && error.message === PATH_ACCESS_DENIED_MESSAGE) {
        return null
      }
      throw error
    }
  }

  async restoreFileExplorerWatchersAfterFailedRemoval(
    rootPath: string,
    connectionId?: string
  ): Promise<void> {
    const leases = getRuntimeFileWatcherLeases(this.host.getRuntimeId(), connectionId, rootPath)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.resume()))
    }
  }

  forgetFileExplorerWatchersAfterRemoval(rootPath: string, connectionId?: string): void {
    const leases = getRuntimeFileWatcherLeases(this.host.getRuntimeId(), connectionId, rootPath)
    if (leases) {
      for (const lease of Array.from(leases)) {
        lease.forget()
      }
    }
  }
}
