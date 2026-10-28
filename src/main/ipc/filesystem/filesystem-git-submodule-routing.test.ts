import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  getStatusMock,
  commitChangesMock,
  stageFileMock,
  unstageFileMock,
  bulkStageFilesMock,
  bulkUnstageFilesMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const resolveInitializedSubmodulePathMock = vi.hoisted(() => vi.fn())
vi.mock('../../git/source-control/submodule-repos', () => ({
  resolveInitializedSubmodulePath: resolveInitializedSubmodulePathMock
}))
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock(
  '../../git/worktree',
  async () => (await import('./filesystem-test-harness')).gitWorktreeMock
)
vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from '../registered-worktree-roots-cache'

const SUBMODULE_PATH = path.join(WORKTREE_FEATURE_PATH, 'libs', 'sub')

const CASES: {
  channel: string
  args: Record<string, unknown>
  mock: () => ReturnType<typeof vi.fn>
  expectedFirstArgs: (cwd: string) => unknown[]
}[] = [
  {
    channel: 'git:status',
    args: {},
    mock: () => getStatusMock,
    expectedFirstArgs: (cwd) => [cwd]
  },
  {
    channel: 'git:stage',
    args: { filePath: 'a.txt' },
    mock: () => stageFileMock,
    expectedFirstArgs: (cwd) => [cwd, 'a.txt']
  },
  {
    channel: 'git:unstage',
    args: { filePath: 'a.txt' },
    mock: () => unstageFileMock,
    expectedFirstArgs: (cwd) => [cwd, 'a.txt']
  },
  {
    channel: 'git:bulkStage',
    args: { filePaths: ['a.txt'] },
    mock: () => bulkStageFilesMock,
    expectedFirstArgs: (cwd) => [cwd, ['a.txt']]
  },
  {
    channel: 'git:bulkUnstage',
    args: { filePaths: ['a.txt'] },
    mock: () => bulkUnstageFilesMock,
    expectedFirstArgs: (cwd) => [cwd, ['a.txt']]
  },
  {
    channel: 'git:commit',
    args: { message: 'msg' },
    mock: () => commitChangesMock,
    expectedFirstArgs: (cwd) => [cwd, 'msg']
  }
]

describe('git handlers that take a submodulePath', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    resolveInitializedSubmodulePathMock.mockReset().mockResolvedValue(SUBMODULE_PATH)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    const handlerStore = store as never
    registerWorktreeRootsForRepo(handlerStore, 'repo-1', [WORKTREE_FEATURE_PATH])
    for (const { mock } of CASES) {
      mock().mockResolvedValue({ entries: [], success: true })
    }
    registerFilesystemHandlers(handlerStore)
  })

  it.each(CASES)('$channel runs in the submodule when one is named', async (testCase) => {
    await handlers.get(testCase.channel)!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      submodulePath: 'libs/sub',
      ...testCase.args
    })

    expect(resolveInitializedSubmodulePathMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      'libs/sub',
      expect.anything()
    )
    expect(testCase.mock().mock.calls[0].slice(0, testCase.expectedFirstArgs('').length)).toEqual(
      testCase.expectedFirstArgs(SUBMODULE_PATH)
    )
  })

  it.each(CASES)('$channel stays on the worktree when no submodule is named', async (testCase) => {
    await handlers.get(testCase.channel)!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      ...testCase.args
    })

    expect(resolveInitializedSubmodulePathMock).not.toHaveBeenCalled()
    expect(testCase.mock().mock.calls[0].slice(0, testCase.expectedFirstArgs('').length)).toEqual(
      testCase.expectedFirstArgs(WORKTREE_FEATURE_PATH)
    )
  })

  it.each(CASES)('$channel refuses a submodule the main process rejects', async (testCase) => {
    resolveInitializedSubmodulePathMock.mockRejectedValue(new Error('Access denied'))

    await expect(
      handlers.get(testCase.channel)!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        submodulePath: '../outside',
        ...testCase.args
      })
    ).rejects.toThrow('Access denied')
    expect(testCase.mock()).not.toHaveBeenCalled()
  })

  it('refuses Stage All by scope inside a submodule', async () => {
    await expect(
      handlers.get('git:bulkStage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        submodulePath: 'libs/sub',
        filePaths: [],
        scope: 'all'
      })
    ).rejects.toThrow('not available for a submodule')
    expect(bulkStageFilesMock).not.toHaveBeenCalled()
  })

  it('refuses a file path that leaves the submodule', async () => {
    await expect(
      handlers.get('git:stage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        submodulePath: 'libs/sub',
        filePath: '../../root.txt'
      })
    ).rejects.toThrow('escapes')
    expect(stageFileMock).not.toHaveBeenCalled()
  })
})
