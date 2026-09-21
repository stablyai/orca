import { afterEach, beforeEach, vi } from 'vitest'
import { awaitRuntimeFileWatcherUnsubscribes, RuntimeFileCommands } from './orca-runtime-files'
import { resetSshConnectionGenerations } from '../ssh/ssh-connection-generation'
import { resetRuntimeFileMocks } from './orca-runtime-files-mock-registry'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'

/** Restores the shared fs/auth/watcher mock state and fake timers around each test. */
export function useRuntimeFileCommandsLifecycle(): void {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    resetRuntimeFileMocks()
    resetSshConnectionGenerations()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(async () => {
    await awaitRuntimeFileWatcherUnsubscribes()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
  })
}

export function createRuntimeFileCommands(options?: {
  path?: string
  hostId?: string
  openFile?: ReturnType<typeof vi.fn>
  openDiff?: ReturnType<typeof vi.fn>
  resolveRuntimeFileTarget?: ReturnType<typeof vi.fn>
  resolveKnownWorkspaceFileTarget?: ReturnType<typeof vi.fn>
  resolveRuntimeGitTarget?: ReturnType<typeof vi.fn>
  resolveTerminalCwd?: ReturnType<typeof vi.fn>
  resolveTerminalContext?: ReturnType<typeof vi.fn>
  resolveTerminalFileUriHostname?: ReturnType<typeof vi.fn>
  hasRecentTerminalOutputPath?: ReturnType<typeof vi.fn>
  hasRecentNativeChatOutputPath?: ReturnType<typeof vi.fn>
}) {
  const store = {
    getRepo: vi.fn((_repoId?: string) => undefined as { connectionId?: string } | undefined)
  }
  const path = options?.path ?? '/repo'
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    ...(options?.hostId ? { hostId: options.hostId } : {})
  }
  // Mirrors the real resolver: the worktree's own host outranks the repo row.
  const runtimeFileTargetExecutionHostId = (): ExecutionHostId => {
    const connectionId = store.getRepo(worktree.repoId)?.connectionId
    return (
      normalizeExecutionHostId(options?.hostId) ??
      (connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID)
    )
  }
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(async () => worktree),
    resolveRuntimeFileTarget:
      options?.resolveRuntimeFileTarget ??
      vi.fn(async () => ({
        worktree,
        executionHostId: runtimeFileTargetExecutionHostId()
      })),
    ...(options?.resolveKnownWorkspaceFileTarget
      ? { resolveKnownWorkspaceFileTarget: options.resolveKnownWorkspaceFileTarget }
      : {}),
    resolveTerminalCwd: options?.resolveTerminalCwd ?? vi.fn(() => path),
    resolveTerminalContext:
      options?.resolveTerminalContext ??
      vi.fn(() => ({
        worktreeId: worktree.id,
        connectionId: store.getRepo(worktree.repoId)?.connectionId ?? null
      })),
    ...(options?.resolveTerminalFileUriHostname
      ? { resolveTerminalFileUriHostname: options.resolveTerminalFileUriHostname }
      : {}),
    hasRecentTerminalOutputPath: options?.hasRecentTerminalOutputPath ?? vi.fn(() => true),
    ...(options?.hasRecentNativeChatOutputPath
      ? { hasRecentNativeChatOutputPath: options.hasRecentNativeChatOutputPath }
      : {}),
    resolveRuntimeGitTarget: options?.resolveRuntimeGitTarget ?? vi.fn(),
    openFile: options?.openFile ?? vi.fn(),
    ...(options?.openDiff ? { openDiff: options.openDiff } : {})
  } as never)
  return { commands, store }
}
