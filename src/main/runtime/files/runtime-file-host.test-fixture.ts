import { afterEach, beforeEach, vi } from 'vitest'
import { awaitRuntimeFileWatcherUnsubscribes } from './watch/file-watcher-leases'
import type { RuntimeFileCommandHost } from './file-command-host'
import { resetSshConnectionGenerations } from '../../ssh/connection/ssh-connection-generation'
import { resetRuntimeFileMocks } from './runtime-file-command-mock-registry'
import {
  getConnectionExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export function useRuntimeFileHostLifecycle(): void {
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

export function createRuntimeFileHost(options?: {
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
    getRepo: vi.fn<(_repoId?: string) => { connectionId?: string } | undefined>(() => undefined)
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: File subjects read only these supplied host/store capabilities.
  const host = {
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
  } as unknown as RuntimeFileCommandHost
  return { host, store }
}
