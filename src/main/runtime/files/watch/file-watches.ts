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
import { resolveAuthorizedPath } from '../../../ipc/filesystem/filesystem-auth'
import { resolveRuntimeAuthorizedPath } from '../chat-scratch-file-root'
import { watchWindowsRuntimeFileExplorer } from './windows-file-watch'
import { beginWatcherInstall } from '../../../ipc/watcher-removal-gate'
import {
  closeFileExplorerWatcherInWatcherProcess,
  watchFileExplorerInWatcherProcess
} from '../../file-watcher-host'

type RuntimeFileWatchHost = Pick<
  RuntimeFileCommandHost,
  'getRuntimeId' | 'requireStore' | 'resolveRuntimeFileTarget'
>

export class RuntimeFileWatches {
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
          const close = watchWindowsRuntimeFileExplorer(rootPath, callback, onTerminalError)
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
      // Failed setup may still own a child without having published a lease-release callback.
      const resolvedRootPath = await resolveAuthorizedPath(rootPath, this.host.requireStore())
      await closeFileExplorerWatcherInWatcherProcess(resolvedRootPath)
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
