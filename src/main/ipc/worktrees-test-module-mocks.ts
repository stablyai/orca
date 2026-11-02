import { type Mock, vi } from 'vitest'
import type { describeCreatedWorktree } from '../git/worktree'
import type { computeWorktreePath } from './worktree-logic'
import type { HandlerMap } from './worktrees-test-ipc-surface'

/** One loose mock type covers unrelated module exports. */
export type ModuleMock = Mock<(...args: unknown[]) => unknown>
export type StringArgMock = Mock<(value: string, ...rest: unknown[]) => unknown>
export type RepoBranchMock = Mock<(repoPath: string, branch: string, ...rest: unknown[]) => unknown>
export type GitArgvMock = Mock<(args: string[], ...rest: unknown[]) => unknown>

export type ParsedWorktreeRow = {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMainWorktree: boolean
}

export const ORIGINAL_PLATFORM = process.platform

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export const removeWorktreeLinkedPathsMock: ModuleMock = vi.fn()
export const findExistingWorktreeSymlinkPathsMock: ModuleMock = vi.fn()
export const handleMock: Mock<(channel: string, handler: HandlerMap[string]) => void> = vi.fn()
export const removeHandlerMock: ModuleMock = vi.fn()
export const listWorktreesMock: StringArgMock = vi.fn()
export const describeCreatedWorktreeMock = vi.fn<typeof describeCreatedWorktree>()
export const parseWorktreeListMock: Mock<(output: string) => ParsedWorktreeRow[]> = vi.fn(
  (output: string) =>
    output
      .trim()
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((block, index) => {
        const lines = block.split(/\r?\n/)
        const path = lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? ''
        const branch = lines.find((line) => line.startsWith('branch '))?.slice(7) ?? ''
        return { path, branch, head: String(index), isBare: false, isMainWorktree: index === 0 }
      })
)
export const assertWorktreeCleanForRemovalMock: ModuleMock = vi.fn()
export const addWorktreeMock: ModuleMock = vi.fn()
export const addSparseWorktreeMock: ModuleMock = vi.fn()
export const removeWorktreeMock: ModuleMock = vi.fn()
export const forceDeleteLocalBranchMock: ModuleMock = vi.fn()
export const resolveLocalGitUsernameMock: ModuleMock = vi.fn()
export const getBaseRefDefaultMock: ModuleMock = vi.fn()
export const resolveDefaultBaseRefWithLocalGitMock: ModuleMock = vi.fn()
export const resolveDefaultBaseRefViaExecMock: ModuleMock = vi.fn()
export const getDefaultRemoteMock: ModuleMock = vi.fn()
export const getBranchConflictKindMock: RepoBranchMock = vi.fn()
export const getPRForBranchMock: RepoBranchMock = vi.fn()
export const getHostedReviewForBranchMock: ModuleMock = vi.fn()
export const getWorkItemMock: ModuleMock = vi.fn()
export const getPullRequestPushTargetMock: ModuleMock = vi.fn()
export const getEffectiveHooksMock: Mock<(repo?: unknown, worktreePath?: string) => unknown> =
  vi.fn()
export const createSetupRunnerScriptMock: ModuleMock = vi.fn()
export const getEffectiveHooksFromConfigMock: ModuleMock = vi.fn()
export const getDefaultTabsLaunchMock: ModuleMock = vi.fn()
export const parseOrcaYamlMock: ModuleMock = vi.fn()
export const shouldRunSetupForCreateMock: ModuleMock = vi.fn()
export const buildPosixRunnerScriptMock: StringArgMock = vi.fn()
export const buildWindowsRunnerScriptMock: StringArgMock = vi.fn()
export const getSetupRunnerEnvVarsMock: Mock<
  (repo: { path: string }, worktreePath: string) => Record<string, string>
> = vi.fn()
export const resolveSetupRunnerShellMock: ModuleMock = vi.fn()
export const runHookMock: ModuleMock = vi.fn()
export const hasHooksFileMock: ModuleMock = vi.fn()
export const loadHooksMock: ModuleMock = vi.fn()
export const computeWorktreePathMock: Mock<typeof computeWorktreePath> = vi.fn()
export const ensurePathWithinWorkspaceMock: StringArgMock = vi.fn()
export const gitExecFileAsyncMock: GitArgvMock = vi.fn()
export const deleteWorktreeHistoryDirMock: ModuleMock = vi.fn()
export const advertisedUrlWatcherForgetWorktreeMock: ModuleMock = vi.fn()
export const pruneCleanupScanSnapshotMock: ModuleMock = vi.fn().mockResolvedValue(undefined)
export const pruneCleanupScanSnapshotsMock: ModuleMock = vi.fn().mockResolvedValue(undefined)
export const pruneSpaceAnalysisSnapshotMock: ModuleMock = vi.fn().mockResolvedValue(undefined)
export const pruneSpaceAnalysisSnapshotsMock: ModuleMock = vi.fn().mockResolvedValue(undefined)
export const recordRemovalSnapshotPruneMock: ModuleMock = vi.fn()
export const killAllProcessesForWorktreeMock: ModuleMock = vi.fn()
export const clearProviderPtyStateMock: ModuleMock = vi.fn()
export const getLocalPtyProviderMock: ModuleMock = vi.fn()

// Hoisted vi.mock factories must call builders instead of closing over module-scope bindings.
export const electronModuleMock = () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
})

export const gitWorktreeModuleMock = () => ({
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesMock,
  listWorktreesSharedStrict: listWorktreesMock,
  listWorktreesSharedStrictAllowingTrueEmpty: listWorktreesMock,
  describeCreatedWorktree: describeCreatedWorktreeMock,
  parseWorktreeList: parseWorktreeListMock,
  assertWorktreeCleanForRemoval: assertWorktreeCleanForRemovalMock,
  addWorktree: addWorktreeMock,
  addSparseWorktree: addSparseWorktreeMock,
  removeWorktree: removeWorktreeMock,
  forceDeleteLocalBranch: forceDeleteLocalBranchMock
})

export const gitRunnerModuleMock = (): {
  gitExecFileAsync: GitArgvMock
  gitExecFileSync: ModuleMock
} => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
})

export const gitRepoModuleMock = () => ({
  getBaseRefDefault: getBaseRefDefaultMock,
  resolveDefaultBaseRefWithLocalGit: resolveDefaultBaseRefWithLocalGitMock,
  resolveDefaultBaseRefViaExec: resolveDefaultBaseRefViaExecMock,
  getDefaultRemote: getDefaultRemoteMock,
  getBranchConflictKind: async (
    repoPath: string,
    branch: string,
    base?: string,
    options?: { wslDistro?: string },
    allowLocalBranch?: () => Promise<boolean>
  ) => {
    // Ref presence is stubbed here; policy tests cover missing refs.
    if (allowLocalBranch && (await allowLocalBranch())) {
      return null
    }
    return getBranchConflictKindMock(repoPath, branch, base, options)
  }
})

export const githubClientModuleMock = () => ({
  getPRForBranch: getPRForBranchMock,
  getWorkItem: getWorkItemMock,
  getPullRequestPushTarget: getPullRequestPushTargetMock
})

export const hostedReviewModuleMock = () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
})

export const worktreeSymlinksModuleMock = (): {
  createWorktreeCopiedPaths: ModuleMock
  createWorktreeLinkedPaths: ModuleMock
  findExistingWorktreeSymlinkPaths: ModuleMock
  removeWorktreeLinkedPaths: ModuleMock
} => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  findExistingWorktreeSymlinkPaths: findExistingWorktreeSymlinkPathsMock,
  removeWorktreeLinkedPaths: removeWorktreeLinkedPathsMock
})

export const hooksModuleMock = () => ({
  getEffectiveHooks: getEffectiveHooksMock,
  loadHooks: loadHooksMock,
  parseOrcaYaml: parseOrcaYamlMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock
})

// Mock each owning module so handler tests cannot invoke real runner-script or hook-config code.
export const setupRunnerScriptTextModuleMock = (actual: Record<string, unknown>) => ({
  ...actual,
  buildPosixRunnerScript: buildPosixRunnerScriptMock,
  buildWindowsRunnerScript: buildWindowsRunnerScriptMock
})

export const worktreeRunnerScriptModuleMock = (actual: Record<string, unknown>) => ({
  ...actual,
  createSetupRunnerScript: createSetupRunnerScriptMock,
  resolveSetupRunnerShell: resolveSetupRunnerShellMock
})

export const effectiveHookConfigModuleMock = (actual: Record<string, unknown>) => ({
  ...actual,
  getDefaultTabsLaunch: getDefaultTabsLaunchMock,
  getEffectiveHooksFromConfig: getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreate: shouldRunSetupForCreateMock
})

export const setupHookEnvVarsModuleMock = (actual: Record<string, unknown>) => ({
  ...actual,
  getSetupRunnerEnvVars: getSetupRunnerEnvVarsMock
})

export const worktreeLogicModuleMock = (actual: Record<string, unknown>) => ({
  ...actual,
  computeWorktreePath: computeWorktreePathMock,
  ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
})

export const terminalHistoryDeletionModuleMock = () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
})

export const advertisedUrlWatcherModuleMock = () => ({
  advertisedUrlWatcher: {
    forgetWorktree: advertisedUrlWatcherForgetWorktreeMock
  }
})

export const workspaceCleanupScanSnapshotModuleMock = () => ({
  pruneWorkspaceCleanupScanSnapshot: pruneCleanupScanSnapshotMock,
  pruneWorkspaceCleanupScanSnapshots: pruneCleanupScanSnapshotsMock
})

export const workspaceSpaceAnalysisSnapshotModuleMock = () => ({
  pruneWorkspaceSpaceAnalysisSnapshot: pruneSpaceAnalysisSnapshotMock,
  pruneWorkspaceSpaceAnalysisSnapshots: pruneSpaceAnalysisSnapshotsMock
})

export const workspaceCleanupRemovalSnapshotPruneModuleMock = () => ({
  recordWorkspaceCleanupRemovalSnapshotPrune: recordRemovalSnapshotPruneMock
})

export const worktreeTeardownModuleMock = () => ({
  killAllProcessesForWorktree: killAllProcessesForWorktreeMock
})

export const ptyRegistryModuleMock = () => ({ getLocalPtyProvider: getLocalPtyProviderMock })

export const ptyStateCleanupModuleMock = () => ({
  clearProviderPtyState: clearProviderPtyStateMock
})
