// @ts-nocheck -- mechanically split declarations.
import type { Store } from '../persistence'
import type {
  ResolvedRuntimeFileTarget,
  ResolvedRuntimeFileWorktree
} from './runtime-file-command-target'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeNativeChatFileContext } from '../../shared/runtime-types'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import {
  MOBILE_BINARY_EXTENSIONS,
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
  WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS
} from './runtime-file-commands-mobile-file-list-limit'
import { watch as watchFs } from 'node:fs'
import { WatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import { basenameFromRelativePath } from './runtime-file-paths'

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): Store
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  resolveKnownWorkspaceFileTarget?(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<(ResolvedRuntimeFileTarget & { relativePath: string }) | null>
  resolveTerminalCwd?(terminalHandle: string): string | null | Promise<string | null>
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveTerminalFileUriHostname?(terminalHandle: string): string | null | Promise<string | null>
  hasRecentTerminalOutputPath?(
    terminalHandle: string,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  hasRecentNativeChatOutputPath?(
    worktreeId: string,
    context: RuntimeNativeChatFileContext,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  // `executionHostId`, not `connectionId`, on both target contracts: a repo row's connection cannot
  // tell `runtime:` from `local`, and neither may re-introduce that spelling. See
  // runtime-git-command-target and runtime-file-command-target.
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; executionHostId: ExecutionHostId }>
  openFile(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ): void
  openDiff(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ): void
}

export function watchWindowsRuntimeFileExplorer(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void,
  onTerminalError: (error: Error) => void
): () => Promise<void> {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let closeStarted = false
  const physicalClose = new PhysicalExitTracker()

  const emitOverflow = (): void => {
    timer = null
    if (disposed) {
      return
    }
    callback([{ kind: 'overflow', absolutePath: rootPath }])
  }

  const scheduleOverflow = (): void => {
    if (disposed) {
      return
    }
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(emitOverflow, WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS)
  }

  // Why: Parcel's Watchman probe can crash the headless server on Windows; use a conservative overflow refresh instead.
  const watcher = watchFs(rootPath, { recursive: true }, scheduleOverflow)
  const onClose = (): void => {
    watcher.removeListener('error', onError)
    physicalClose.markExited()
  }
  const onError = (err: Error): void => {
    console.error('[runtime-files.watch] Windows watcher error', { rootPath, err })
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    watcher.removeListener('close', onClose)
    watcher.removeListener('error', onError)
    // Why: Node nulls FSWatcher's native handle on error without a close event; treat the error as physical-exit proof.
    physicalClose.markExited()
    if (!disposed) {
      try {
        callback([{ kind: 'overflow', absolutePath: rootPath }])
      } finally {
        onTerminalError(err)
      }
    }
  }
  watcher.once('close', onClose)
  watcher.on('error', onError)

  return async () => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!closeStarted) {
      try {
        watcher.close()
      } catch (err) {
        console.error('[runtime-files.watch] Windows watcher close error', { rootPath, err })
        throw err
      }
      closeStarted = true
    }
    try {
      await physicalClose.waitForExit(
        WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
        () => new Error('Windows watcher did not close before deletion deadline')
      )
    } catch (error) {
      // Why: late Windows close still owns native dir handles; expose its completion so cleanup retains then clears the root.
      throw new WatcherProcessFailure(
        error instanceof Error ? error.message : String(error),
        'supervisor',
        'process_unavailable',
        physicalClose.exitedPromise
      )
    }
  }
}

export function isSafeMobileRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return false
  }
  const parts = relativePath.replace(/\\/g, '/').split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

export function isMobileMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}

export function isMobileBinaryPath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

export function isRuntimeDirectoryEntry(entry: {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): boolean {
  // Why: listings are passive UI reads; don't stat symlink targets here (explicit open/expand resolves them).
  if (entry.isSymbolicLink()) {
    return false
  }
  if (entry.isDirectory()) {
    return true
  }
  return false
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}
