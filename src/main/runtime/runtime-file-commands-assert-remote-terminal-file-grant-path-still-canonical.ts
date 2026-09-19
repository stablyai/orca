// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithWriteTerminalArtifactFile } from './runtime-file-commands-write-terminal-artifact-file'
import type { TerminalFileGrant } from './runtime-file-commands-mobile-file-list-limit'
import {
  runtimeFileWatcherLeasesByOwnerAndRoot,
  runtimeWatcherReleaseKey
} from './runtime-file-commands-mobile-file-list-limit'
import type { IFilesystemProvider } from '../providers/types'
import {
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget,
  runtimeFileSshTargetId
} from './runtime-file-command-target'
import { readdir, stat } from 'node:fs/promises'
import type { DirEntry, FsChangeEvent } from '../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../shared/file-name-sort'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import {
  isRuntimeDirectoryEntry,
  watchWindowsRuntimeFileExplorer
} from './runtime-file-command-host'
import { beginWatcherInstall } from '../ipc/watcher-removal-gate'
import {
  armSshFileExplorerWatchRearm,
  stopSshFileExplorerWatchRearms
} from './runtime-file-commands-ssh-file-watcher-rearm'
import {
  closeFileExplorerWatcherInWatcherProcess,
  watchFileExplorerInWatcherProcess
} from './file-watcher-host'
import { registerRuntimeFileWatcherRelease } from './runtime-file-watcher-leases'

export class RuntimeFileCommandsWithAssertRemoteTerminalFileGrantPathStillCanonical extends RuntimeFileCommandsWithWriteTerminalArtifactFile {
  protected async assertRemoteTerminalFileGrantPathStillCanonical(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    if (!grant.connectionId) {
      throw new Error('terminal_file_grant_mismatch')
    }
    const provider = getSshFilesystemProvider(grant.connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const canonicalPath =
      grant.provenance === 'native-chat'
        ? await provider.realpath(grant.absolutePath)
        : await this.resolveAllowedRemoteTerminalArtifactPath(
            grant.absolutePath,
            grant.connectionId
          )
    // Why: relay I/O follows symlinks, so re-canonicalize after the remote process can mutate the path.
    if (canonicalPath !== grant.absolutePath) {
      throw new Error('terminal_file_grant_stale')
    }
    return provider
  }

  async readFileExplorerDir(worktreeSelector: string, relativePath: string): Promise<DirEntry[]> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      // Why: re-sort locally — the remote relay may be an older build with
      // lexicographic ordering.
      return sortDirEntries(await provider.readDir(target.path))
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const entries = await readdir(dirPath, { withFileTypes: true })
    const mapped = entries.map((entry) => ({
      name: entry.name,
      isDirectory: isRuntimeDirectoryEntry(entry),
      isSymlink: entry.isSymbolicLink()
    }))
    return sortDirEntries(mapped)
  }

  async watchFileExplorer(
    worktreeSelector: string,
    callback: (events: FsChangeEvent[]) => void,
    onTerminalError: (error: Error) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<() => Promise<void>> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, '')
    // Why: watcher keys must scope teardown to the owning host; a `runtime:` host throws here
    // rather than registering a lease under this client's namespace.
    const sshTargetId = runtimeFileSshTargetId(target)
    const open = async (): Promise<{
      unsubscribe: () => Promise<void>
      rootPaths: string[]
    }> => {
      const finishInstall = beginWatcherInstall(target.path, sshTargetId)
      try {
        // Re-resolved per open: a reconnect mints a fresh provider for the same target.
        const route = runtimeFileRouteForTarget(target)
        if (route.kind === 'ssh') {
          if (!route.provider) {
            throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
          }
          // Why: the RPC layer already threads AbortSignal for local watches; SSH must cancel the remote fs.watch, not wait it out.
          const close = await route.provider.watch(target.path, callback, {
            signal,
            onTerminalError
          })
          const rearm = armSshFileExplorerWatchRearm({
            runtimeId: this.host.getRuntimeId(),
            connectionId: route.connectionId,
            rootPath: target.path,
            callback,
            onTerminalError,
            signal,
            initialUnwatch: close
          })
          return { unsubscribe: rearm.unsubscribe, rootPaths: [target.path] }
        }

        const rootPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
        const rootStats = await stat(rootPath)
        if (!rootStats.isDirectory()) {
          throw new Error('not_a_directory')
        }
        if (process.platform === 'win32') {
          const close = watchWindowsRuntimeFileExplorer(rootPath, callback, onTerminalError)
          return { unsubscribe: close, rootPaths: [target.path, rootPath] }
        }
        // Why: the forked watcher keeps the blocking crawl and native faults out of the main/`serve` process (issues #5308, #8212).
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
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.suspend()))
    }
    if (!connectionId) {
      // Why: setup can fail before registerRuntimeFileWatcherRelease publishes its callback while the child owner still lives.
      const resolvedRootPath = await resolveAuthorizedPath(rootPath, this.host.requireStore())
      await closeFileExplorerWatcherInWatcherProcess(resolvedRootPath)
    }
  }

  async restoreFileExplorerWatchersAfterFailedRemoval(
    rootPath: string,
    connectionId?: string
  ): Promise<void> {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.resume()))
    }
  }

  forgetFileExplorerWatchersAfterRemoval(rootPath: string, connectionId?: string): void {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    // Why: forget() never runs the lease's unsubscribe, so the re-arm would outlive a deleted
    // worktree and re-watch it on the next reconnect.
    stopSshFileExplorerWatchRearms(key)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      for (const lease of Array.from(leases)) {
        lease.forget()
      }
    }
  }
}
