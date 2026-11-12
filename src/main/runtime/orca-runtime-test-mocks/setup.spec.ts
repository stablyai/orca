export * from './github-hosted-review-test-harness'
export * from './gitlab-test-harness'
import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import { vi, type Mock } from 'vitest'

import type * as GitUsernameModule from '../../git/repositories/git-username'
import './repo-creation.spec'
import type * as WslUncAccessGateModule from '../../wsl/filesystem/wsl-unc-access-gate'
import type * as FilesystemPathContainmentModule from '../../ipc/filesystem/access/filesystem-path-containment'
import { reviewHeadRemoteRefComponent } from '../../../shared/review-head-tracking-ref'

export const ORIGIN_REMOTE_URL = 'git@example.com:group/repo.git'
export const ORIGIN_HEAD_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_REMOTE_URL)
import type { OrcaRuntimeService as OrcaRuntimeServiceConstructor } from '../orca-runtime'
import { setWorktreeWatcherRemoval } from '../../workspaces/removal/worktree-watcher-removal'

type TestMock = Mock

const reconcileClaudeAgentViewMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = await getWorktreeOwnerMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees,
    listWorktreesSharedStrict: (await getWorktreeOwnerMocks()).listWorktreesSharedStrict
  }
})

vi.mock('../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({
    reconcile: reconcileClaudeAgentViewMock,
    ready: async () => {},
    readyForLaunch: async () => {},
    prepareProfile: async () => {},
    read: () => undefined
  })
}))

export const ORIGINAL_PLATFORM = process.platform
export const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')
const removeWorktreeLinkedPathsMock: ReturnType<typeof vi.fn> = vi.hoisted(() => vi.fn())
const findExistingWorktreeSymlinkPathsMock: TestMock = vi.hoisted(() => vi.fn())
const resolveLocalGitUsernameMock: TestMock = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('../../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn(),
  findExistingWorktreeSymlinkPaths: findExistingWorktreeSymlinkPathsMock,
  removeWorktreeLinkedPaths: removeWorktreeLinkedPathsMock
}))

vi.mock('../../git/worktrees/content-paths/worktree-symlink-detection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findExistingWorktreeSymlinkPaths: findExistingWorktreeSymlinkPathsMock
}))

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export function resetPlatform(): void {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR)
  }
}

export function acknowledgeAgentPromptSubmit(
  runtime: InstanceType<typeof OrcaRuntimeServiceConstructor>,
  ptyId: string,
  data: string
): void {
  if (data === '\r') {
    runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
  }
}

const electronMocks = await vi.hoisted(async () => {
  const { fakeAppEnvironment } =
    await import('../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup')
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? new Set<Listener>()
      existing.add(listener)
      listeners.set(channel, existing)
      return ipcMain
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
      return ipcMain
    }),
    emit: vi.fn((channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args)
      }
      return true
    })
  }
  return {
    BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
    webContents: { fromId: vi.fn((_id: number): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => fakeAppEnvironment().getPath('userData')), isPackaged: false }
  }
})

const closeLocalWatcherForWorktreePathMock: TestMock = vi.hoisted(() => vi.fn())
const restoreLocalWatcherAfterFailedRemovalMock: TestMock = vi.hoisted(() => vi.fn())
const forgetLocalWatcherRemovalSnapshotMock: TestMock = vi.hoisted(() => vi.fn())
const scanLocalRepoWorktreesForResolutionMock: TestMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => electronMocks)
// Runtime calls the WorktreeWatcherRemoval port; filesystem-watcher module mocks would be inert.
setWorktreeWatcherRemoval({
  closeLocal: closeLocalWatcherForWorktreePathMock,
  restoreLocal: restoreLocalWatcherAfterFailedRemovalMock,
  forgetLocal: forgetLocalWatcherRemovalSnapshotMock
})

const {
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  applyAgentStatusHooksEnabledMock,
  detectAgentCommandsOnHostMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  deleteWorktreeHistoryDirMock
} = vi.hoisted(() => {
  return {
    MOCK_GIT_WORKTREES: [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ],
    addSparseWorktreeMock: vi.fn() as TestMock,
    addWorktreeMock: vi.fn() as TestMock,
    removeWorktreeMock: vi.fn() as TestMock,
    forceDeleteLocalBranchMock: vi.fn() as TestMock,
    computeWorktreePathMock: vi.fn() as TestMock,
    ensurePathWithinWorkspaceMock: vi.fn() as TestMock,
    invalidateAuthorizedRootsCacheMock: vi.fn() as TestMock,
    prepareLocalWorktreeRootForRepoMock: vi.fn() as TestMock,
    applyAgentStatusHooksEnabledMock: vi.fn() as TestMock,
    detectAgentCommandsOnHostMock: vi.fn(async () => new Set(['qodercli'])),
    detectInstalledAgentsWithShellPathHydrationMock: vi.fn() as TestMock,
    markCodexProjectTrustedMock: vi.fn() as TestMock,
    markCopilotFolderTrustedMock: vi.fn() as TestMock,
    markCursorWorkspaceTrustedMock: vi.fn() as TestMock,
    deleteWorktreeHistoryDirMock: vi.fn() as TestMock
  }
})

const listWorktreesStrictMock = vi.hoisted(() => vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock,
  describeCreatedWorktree: (await getWorktreeOwnerMocks()).describeCreatedWorktree
}))

// Fire-and-forget reclaim runs real Git on fixture paths and warns after the file ends.
vi.mock(
  '../../workspaces/creation/preparation/worktree-create-preparation-project-removal',
  () => ({ releaseWorktreeCreatePreparationsForRepo: vi.fn() })
)

const { getWorktreeOwnerMocks } = vi.hoisted(() => {
  function createWorktreeOwnerMocks() {
    return (() => ({
      listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
      listWorktreesSharedStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
      listWorktreesStrict: listWorktreesStrictMock,
      describeCreatedWorktree: vi.fn().mockResolvedValue(undefined),
      assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
      addSparseWorktree: addSparseWorktreeMock,
      addWorktree: addWorktreeMock,
      removeWorktree: removeWorktreeMock,
      forceDeleteLocalBranch: forceDeleteLocalBranchMock
    }))()
  }
  let fixture: ReturnType<typeof createWorktreeOwnerMocks> | undefined
  return { getWorktreeOwnerMocks: () => (fixture ??= createWorktreeOwnerMocks()) }
})

vi.mock('../../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await getWorktreeOwnerMocks()).assertWorktreeCleanForRemoval
}))

vi.mock('../../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await getWorktreeOwnerMocks()).addSparseWorktree
}))

vi.mock('../../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await getWorktreeOwnerMocks()).addWorktree
}))

vi.mock('../../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await getWorktreeOwnerMocks()).removeWorktree
}))

vi.mock('../../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await getWorktreeOwnerMocks()).forceDeleteLocalBranch
}))

vi.mock('../workspaces/catalog/repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution: scanLocalRepoWorktreesForResolutionMock
}))

// Fake-win32 runtime tests have no wsl.exe: treat every distro as running unless a test says otherwise.
vi.mock('../../wsl/filesystem/wsl-unc-access-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof WslUncAccessGateModule>()
  const blockedWslDistroForPath = vi.fn<typeof actual.blockedWslDistroForPath>(async () => null)
  return {
    ...actual,
    blockedWslDistroForPath,
    // The real guard asks its own module's check, which this mock can't reach; ask the mocked one.
    guardWslUncPathAccess: vi.fn(
      async <T>(
        path: string,
        access: () => Promise<T>,
        options: { wake?: boolean; wslDistro?: string | null } = {}
      ): Promise<T> => {
        const blocked = options.wake ? null : await blockedWslDistroForPath(path, options.wslDistro)
        if (blocked?.state === 'stopped') {
          throw new actual.WslDistroStoppedError(blocked.distro)
        }
        if (blocked) {
          throw new actual.WslDistroUnverifiableError(blocked.distro)
        }
        return access()
      }
    )
  }
})

vi.mock('../../pty/history/terminal-history-deletion', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => null,
  getRegisteredSshState: () => ({ remotePlatform: 'linux' })
}))

vi.mock('../../preflight/agent-command-detection', () => ({
  detectAgentCommandsOnHost: detectAgentCommandsOnHostMock
}))

vi.mock('../../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: detectAgentCommandsOnHostMock,
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock
}))

vi.mock('../../agent-hooks/installation/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../../agent-launch/trust/agent-trust-presets', () => ({
  markCodexProjectTrusted: markCodexProjectTrustedMock,
  markCopilotFolderTrusted: markCopilotFolderTrustedMock,
  markCursorWorkspaceTrusted: markCursorWorkspaceTrustedMock
}))

const parseOrcaYamlMock = vi.hoisted(() => vi.fn().mockReturnValue(null))
vi.mock('../../../shared/orca-yaml', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseOrcaYaml: parseOrcaYamlMock
}))

vi.mock('../../workspace-hooks/hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  loadHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' }),
  hasHooksFile: vi.fn().mockReturnValue(false)
}))

vi.mock('../../workspace-hooks/setup-runner-script-text', () => ({
  buildPosixRunnerScript: (script: string) => `#!/usr/bin/env bash\nset -e\n${script}\n`,
  buildWindowsRunnerScript: (script: string) => `@echo off\r\n${script}\r\n`
}))

vi.mock('../../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: vi.fn(),
  resolveSetupRunnerShell: vi.fn().mockReturnValue(undefined)
}))

vi.mock('../../workspace-hooks/setup-hook-env-vars', () => ({
  getSetupRunnerEnvVars: (_repo: never, worktreePath: string) => ({
    ORCA_ROOT_PATH: '/remote/repo',
    ORCA_WORKTREE_PATH: worktreePath
  })
}))

vi.mock('../../workspace-hooks/effective-hook-config', () => ({
  getEffectiveHooksFromConfig: vi.fn().mockReturnValue(null),
  getDefaultTabsLaunch: vi.fn().mockReturnValue(undefined),
  shouldRunSetupForCreate: vi
    .fn()
    .mockImplementation((_repo: never, decision: string) => decision === 'run'),
  getEffectiveSetupRunPolicy: vi.fn().mockReturnValue('auto')
}))

vi.mock('../../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

vi.mock('../../ipc/filesystem/access/filesystem-auth', () => ({
  resolveAuthorizedPath: vi.fn(async (pathValue: string) => pathValue)
}))

vi.mock('../../ipc/worktrees/removal/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../../ipc/worktrees/removal/registered-worktree-roots-scoped-invalidation', () => ({
  invalidateAuthorizedRootsCacheForRepo: invalidateAuthorizedRootsCacheMock
}))

// Relay-rebuilt ENOENT errors may retain only the message.
vi.mock('../../ipc/filesystem/access/filesystem-path-containment', async () => {
  const actual = await vi.importActual<typeof FilesystemPathContainmentModule>(
    '../../ipc/filesystem/access/filesystem-path-containment'
  )
  return { isENOENT: actual.isENOENT }
})

vi.mock('../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../../git/repositories/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>(
    '../../git/repositories/git-username'
  )
  return { ...actual, resolveLocalGitUsername: resolveLocalGitUsernameMock }
})

export {
  electronMocks,
  removeWorktreeLinkedPathsMock,
  findExistingWorktreeSymlinkPathsMock,
  resolveLocalGitUsernameMock,
  closeLocalWatcherForWorktreePathMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  forgetLocalWatcherRemovalSnapshotMock,
  scanLocalRepoWorktreesForResolutionMock,
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  applyAgentStatusHooksEnabledMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  deleteWorktreeHistoryDirMock
}

export { reconcileClaudeAgentViewMock }

vi.mock(import('../../preflight/installed-agent-detection'), async (importOriginal) => ({
  ...(await importOriginal()),
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock
}))
