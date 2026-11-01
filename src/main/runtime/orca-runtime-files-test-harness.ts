import { afterEach, beforeEach, vi } from 'vitest'
import { awaitRuntimeFileWatcherUnsubscribes } from './files/watch/file-watcher-leases'
import { RuntimeFileCommands } from './orca-runtime-files'
import { resetSshConnectionGenerations } from '../ssh/connection/ssh-connection-generation'
import { resetRuntimeFileMocks } from './orca-runtime-files-mock-registry'
import {
  getConnectionExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'

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
  resolveTerminalFileUriHostname?: ReturnType<typeof vi.fn>
}) {
  const store = {
    getSettings: vi.fn(() => ({ followSymlinkedDirectories: false })),
    getRepo: vi.fn((_repoId?: string) => undefined as { connectionId?: string } | undefined)
  }
  const path = options?.path ?? '/repo'
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    ...(options?.hostId ? { hostId: options.hostId } : {})
  }
  // Worktree host outranks repo metadata, matching the real resolver.
  const runtimeFileTargetExecutionHostId = (): ExecutionHostId => {
    const connectionId = store.getRepo(worktree.repoId)?.connectionId
    return normalizeExecutionHostId(options?.hostId) ?? getConnectionExecutionHostId(connectionId)
  }
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
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
    ...(options?.resolveTerminalFileUriHostname
      ? { resolveTerminalFileUriHostname: options.resolveTerminalFileUriHostname }
      : {}),
    resolveRuntimeGitTarget: options?.resolveRuntimeGitTarget ?? vi.fn(),
    openFile: options?.openFile ?? vi.fn(),
    ...(options?.openDiff ? { openDiff: options.openDiff } : {})
  } as never)
  return { commands, store }
}
