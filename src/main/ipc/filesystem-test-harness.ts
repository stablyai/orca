import path from 'node:path'
import { type Mock, vi } from 'vitest'

/** Loose signature: these mocks stand in for many unrelated module exports. */
type IpcMock = Mock<(...args: any[]) => unknown>

// Why: paths are resolved via path.resolve() in production code, so test
// data must use resolved paths to avoid Unix-vs-Windows mismatches.
export const REPO_PATH = path.resolve('/workspace/repo')
export const WORKSPACE_DIR = path.resolve('/workspace')
export const WORKTREE_FEATURE_PATH = path.resolve('/workspace/repo-feature')

export const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()

export const handleMock: IpcMock = vi.fn()
export const showSaveDialogMock: IpcMock = vi.fn()
export const showOpenDialogMock: IpcMock = vi.fn()
export const fromWebContentsMock: IpcMock = vi.fn()
export const trashItemMock: IpcMock = vi.fn()
export const readdirMock: IpcMock = vi.fn()
export const readFileMock: IpcMock = vi.fn()
export const writeFileMock: IpcMock = vi.fn()
export const statMock: IpcMock = vi.fn()
export const openMock: IpcMock = vi.fn()
export const renameMock: IpcMock = vi.fn()
export const rmMock: IpcMock = vi.fn()
export const realpathMock: IpcMock = vi.fn()
export const lstatMock: IpcMock = vi.fn()
export const commitChangesMock: IpcMock = vi.fn()
export const getStatusMock: IpcMock = vi.fn()
export const detectConflictOperationMock: IpcMock = vi.fn()
export const abortMergeMock: IpcMock = vi.fn()
export const abortRebaseMock: IpcMock = vi.fn()
export const getDiffMock: IpcMock = vi.fn()
export const getBranchCompareMock: IpcMock = vi.fn()
export const getBranchDiffMock: IpcMock = vi.fn()
export const getStagedCommitContextMock: IpcMock = vi.fn()
export const stageFileMock: IpcMock = vi.fn()
export const bulkStageFilesMock: IpcMock = vi.fn()
export const unstageFileMock: IpcMock = vi.fn()
export const bulkUnstageFilesMock: IpcMock = vi.fn()
export const bulkDiscardChangesMock: IpcMock = vi.fn()
export const discardChangesMock: IpcMock = vi.fn()
export const checkIgnoredPathsMock: IpcMock = vi.fn()
export const listWorktreesMock: IpcMock = vi.fn()
export const resolveCommitMessageSettingsMock: IpcMock = vi.fn()
export const generateCommitMessageFromContextMock: IpcMock = vi.fn()
export const generatePullRequestFieldsFromContextMock: IpcMock = vi.fn()
export const discoverCommitMessageModelsLocalMock: IpcMock = vi.fn()
export const discoverCommitMessageModelsRemoteMock: IpcMock = vi.fn()
export const cancelGenerateCommitMessageLocalMock: IpcMock = vi.fn()
export const cancelGeneratePullRequestFieldsLocalMock: IpcMock = vi.fn()
export const getPullRequestDraftContextMock: IpcMock = vi.fn()
export const resolveHostedReviewBodyForGenerationMock: IpcMock = vi.fn()
export const loadPullRequestLinkedIssueMock: IpcMock = vi.fn()
export const getSshFilesystemProviderMock: IpcMock = vi.fn()
export const getSshGitProviderMock: IpcMock = vi.fn()
export const tryDeleteWslUncPathMock: IpcMock = vi.fn()
export const recordCrashBreadcrumbMock: IpcMock = vi.fn()
export const promoteLocalDownloadedFolderMock: IpcMock = vi.fn()

export const electronMock = {
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  dialog: { showSaveDialog: showSaveDialogMock, showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: handleMock },
  shell: { trashItem: trashItemMock }
}

export const fsPromisesMock = {
  readdir: readdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  stat: statMock,
  open: openMock,
  rename: renameMock,
  rm: rmMock,
  realpath: realpathMock,
  lstat: lstatMock
}

export const wslUncDeleteMock = { tryDeleteWslUncPath: tryDeleteWslUncPathMock }

export const crashBreadcrumbMock = { recordCrashBreadcrumb: recordCrashBreadcrumbMock }

export const folderPromotionMock = {
  promoteLocalDownloadedFolder: promoteLocalDownloadedFolderMock
}

export const gitStatusModuleMock = {
  commitChanges: commitChangesMock,
  getStatus: getStatusMock,
  detectConflictOperation: detectConflictOperationMock,
  abortMerge: abortMergeMock,
  abortRebase: abortRebaseMock,
  getDiff: getDiffMock,
  getBranchCompare: getBranchCompareMock,
  getBranchDiff: getBranchDiffMock,
  getStagedCommitContext: getStagedCommitContextMock,
  stageFile: stageFileMock,
  bulkStageFiles: bulkStageFilesMock,
  unstageFile: unstageFileMock,
  bulkUnstageFiles: bulkUnstageFilesMock,
  bulkDiscardChanges: bulkDiscardChangesMock,
  discardChanges: discardChangesMock
}

export const gitIgnoredPathsMock = { checkIgnoredPaths: checkIgnoredPathsMock }

export const gitWorktreeMock = {
  listWorktreeGraph: listWorktreesMock,
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesMock
}

const PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export const sshFilesystemDispatchMock = {
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: PROVIDER_UNAVAILABLE_MESSAGE,
  requireSshFilesystemProvider: (connectionId: string) => {
    const provider = getSshFilesystemProviderMock(connectionId)
    if (!provider) {
      throw new Error(PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return provider
  }
}

export const sshGitDispatchMock = {
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: PROVIDER_UNAVAILABLE_MESSAGE
}

export const textGenerationModuleMock = {
  resolveCommitMessageSettings: resolveCommitMessageSettingsMock,
  generateCommitMessageFromContext: generateCommitMessageFromContextMock,
  generatePullRequestFieldsFromContext: generatePullRequestFieldsFromContextMock,
  discoverCommitMessageModelsLocal: discoverCommitMessageModelsLocalMock,
  discoverCommitMessageModelsRemote: discoverCommitMessageModelsRemoteMock,
  cancelGenerateCommitMessageLocal: cancelGenerateCommitMessageLocalMock,
  cancelGeneratePullRequestFieldsLocal: cancelGeneratePullRequestFieldsLocalMock
}

export const pullRequestContextMock = {
  getPullRequestDraftContext: getPullRequestDraftContextMock
}

export const pullRequestTemplateMock = {
  readHostedPullRequestTemplate: vi.fn() as IpcMock,
  readHostedReviewTemplate: vi.fn() as IpcMock,
  resolveHostedReviewBodyForGeneration: resolveHostedReviewBodyForGenerationMock
}

export const pullRequestLinkedIssueMock = {
  loadPullRequestLinkedIssue: loadPullRequestLinkedIssueMock
}

export const store = {
  getRepos: () => [
    {
      id: 'repo-1',
      path: REPO_PATH,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
  ],
  getSettings: () => ({
    workspaceDir: WORKSPACE_DIR
  })
}

type MockDirEntry = {
  name: string
  directory?: boolean
  file?: boolean
  symlink?: boolean
}

export function dirEntry({ name, directory, file, symlink }: MockDirEntry): {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
} {
  return {
    name,
    isDirectory: () => directory ?? false,
    isFile: () => file ?? false,
    isSymbolicLink: () => symlink ?? false
  }
}

export async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

function collectMocks(moduleMock: object): IpcMock[] {
  return Object.values(moduleMock).flatMap((value) => {
    if (vi.isMockFunction(value)) {
      return [value as IpcMock]
    }
    return value && typeof value === 'object' ? collectMocks(value) : []
  })
}

const ALL_MOCKS = [
  electronMock,
  fsPromisesMock,
  wslUncDeleteMock,
  crashBreadcrumbMock,
  folderPromotionMock,
  gitStatusModuleMock,
  gitIgnoredPathsMock,
  gitWorktreeMock,
  sshFilesystemDispatchMock,
  sshGitDispatchMock,
  textGenerationModuleMock,
  pullRequestContextMock,
  pullRequestTemplateMock,
  pullRequestLinkedIssueMock
].flatMap(collectMocks)

/** Resets every filesystem IPC mock and reinstalls the defaults every suite starts from. */
export function resetFilesystemIpcMocks(): void {
  handlers.clear()
  for (const mock of ALL_MOCKS) {
    mock.mockReset()
  }
  loadPullRequestLinkedIssueMock.mockResolvedValue(null)

  handleMock.mockImplementation(
    (channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  )

  realpathMock.mockImplementation(async (targetPath: string) => targetPath)
  listWorktreesMock.mockResolvedValue([
    {
      path: WORKTREE_FEATURE_PATH,
      head: 'abc',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
  ])
  trashItemMock.mockResolvedValue(undefined)
  // Default: not a WSL UNC path, so deletePath falls through to shell.trashItem.
  tryDeleteWslUncPathMock.mockResolvedValue(false)
  promoteLocalDownloadedFolderMock.mockResolvedValue(undefined)
  showSaveDialogMock.mockResolvedValue({ canceled: true })
  showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
  fromWebContentsMock.mockReturnValue(null)
  getSshGitProviderMock.mockReturnValue(null)
  statMock.mockResolvedValue({ size: 10, isDirectory: () => false, mtimeMs: 123 })
  renameMock.mockResolvedValue(undefined)
  rmMock.mockResolvedValue(undefined)
  openMock.mockResolvedValue({
    read: vi.fn(async (buffer: Buffer) => {
      buffer.fill(0x61)
      return { bytesRead: buffer.length, buffer }
    }),
    write: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn()
  })
  lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
}
