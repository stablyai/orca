import { beforeEach, describe, expect, it, vi } from 'vitest'

const { git } = vi.hoisted(() => ({
  git: {
    getStatus: vi.fn(),
    getSubmoduleStatus: vi.fn(),
    checkIgnoredPaths: vi.fn(),
    getHistory: vi.fn(),
    commitChanges: vi.fn(),
    getStagedCommitContext: vi.fn(),
    getDiff: vi.fn(),
    stageFile: vi.fn(),
    unstageFile: vi.fn(),
    bulkStageFiles: vi.fn(),
    stageWorktreeChanges: vi.fn(),
    bulkUnstageFiles: vi.fn(),
    discardChanges: vi.fn(),
    bulkDiscardChanges: vi.fn(),
    detectConflictOperation: vi.fn(),
    abortMerge: vi.fn(),
    abortRebase: vi.fn(),
    checkoutBranch: vi.fn(),
    listLocalBranches: vi.fn(),
    getBranchCompare: vi.fn(),
    getCommitCompare: vi.fn(),
    getCommitDiff: vi.fn(),
    getUpstreamStatus: vi.fn(),
    gitPush: vi.fn(),
    gitPull: vi.fn(),
    gitFastForward: vi.fn(),
    gitPullRebaseFromBase: vi.fn(),
    gitFetch: vi.fn(),
    gitSyncForkDefaultBranch: vi.fn(),
    listWorktrees: vi.fn(),
    isGitRepo: vi.fn(),
    gitExecFileAsync: vi.fn(),
    awaitWindowsHostGitEnvironmentReady: vi.fn(),
    getRemoteFileUrl: vi.fn(),
    getRemoteCommitUrl: vi.fn()
  }
}))

vi.mock('../git/status', () => git)
vi.mock('../git/check-ignored-paths', () => ({ checkIgnoredPaths: git.checkIgnoredPaths }))
vi.mock('../git/checkout', () => ({
  checkoutBranch: git.checkoutBranch,
  listLocalBranches: git.listLocalBranches
}))
vi.mock('../git/history', () => ({ getHistory: git.getHistory }))
vi.mock('../git/remote', () => git)
vi.mock('../git/fork-sync', () => ({ gitSyncForkDefaultBranch: git.gitSyncForkDefaultBranch }))
vi.mock('../git/upstream', () => ({ getUpstreamStatus: git.getUpstreamStatus }))
vi.mock('../git/worktree', () => ({ listWorktrees: git.listWorktrees }))
vi.mock('../git/repo', () => git)
vi.mock('../git/runner', () => git)

import { createLocalGitProvider, type LocalGitProvider } from './local-git-provider'

const WT = '/repo/wt'
const pushTarget = { remoteName: 'origin', branchName: 'feature' }
const interactive = { admissionTier: 'interactive' }

// [provider call, free function, expected free-function args] — mirrors the runtime local arms.
type ParityCase = [string, (p: LocalGitProvider) => unknown, keyof typeof git, unknown[]]
const cases: ParityCase[] = [
  ['getStatus', (p) => p.getStatus(WT), 'getStatus', [WT, { admissionTier: 'status' }]],
  [
    'getStatus with options',
    (p) => p.getStatus(WT, { includeIgnored: true, admissionTier: 'background' }),
    'getStatus',
    [WT, { includeIgnored: true, admissionTier: 'background' }]
  ],
  [
    'getSubmoduleStatus staged',
    (p) => p.getSubmoduleStatus(WT, 'sub', 'staged'),
    'getSubmoduleStatus',
    [WT, 'sub', { ...interactive, staged: true }]
  ],
  [
    'getSubmoduleStatus default',
    (p) => p.getSubmoduleStatus(WT, 'sub'),
    'getSubmoduleStatus',
    [WT, 'sub', interactive]
  ],
  [
    'checkIgnoredPaths',
    (p) => p.checkIgnoredPaths(WT, ['a']),
    'checkIgnoredPaths',
    [WT, ['a'], interactive]
  ],
  [
    'getHistory',
    (p) => p.getHistory(WT, { limit: 5 }),
    'getHistory',
    [WT, { limit: 5, ...interactive }]
  ],
  ['commit', (p) => p.commit(WT, 'msg'), 'commitChanges', [WT, 'msg', interactive]],
  [
    'getStagedCommitContext',
    (p) => p.getStagedCommitContext(WT),
    'getStagedCommitContext',
    [WT, interactive]
  ],
  ['getDiff', (p) => p.getDiff(WT, 'a', true, true), 'getDiff', [WT, 'a', true, true, interactive]],
  ['stageFile', (p) => p.stageFile(WT, 'a'), 'stageFile', [WT, 'a', interactive]],
  ['unstageFile', (p) => p.unstageFile(WT, 'a'), 'unstageFile', [WT, 'a', interactive]],
  [
    'bulkStageFiles',
    (p) => p.bulkStageFiles(WT, ['a']),
    'bulkStageFiles',
    [WT, ['a'], interactive]
  ],
  [
    'bulkStageFiles scoped',
    (p) => p.bulkStageFiles(WT, [], 'all'),
    'stageWorktreeChanges',
    [WT, 'all', { ...interactive, sharedLinkPaths: [] }]
  ],
  [
    'bulkUnstageFiles',
    (p) => p.bulkUnstageFiles(WT, ['a']),
    'bulkUnstageFiles',
    [WT, ['a'], interactive]
  ],
  ['discardChanges', (p) => p.discardChanges(WT, 'a'), 'discardChanges', [WT, 'a', interactive]],
  [
    'bulkDiscardChanges',
    (p) => p.bulkDiscardChanges(WT, ['a']),
    'bulkDiscardChanges',
    [WT, ['a'], interactive]
  ],
  [
    'detectConflictOperation',
    (p) => p.detectConflictOperation(WT),
    'detectConflictOperation',
    [WT, {}]
  ],
  ['abortMerge', (p) => p.abortMerge(WT), 'abortMerge', [WT, interactive]],
  ['abortRebase', (p) => p.abortRebase(WT), 'abortRebase', [WT, interactive]],
  ['checkoutBranch', (p) => p.checkoutBranch(WT, 'b'), 'checkoutBranch', [WT, 'b', interactive]],
  ['listLocalBranches', (p) => p.listLocalBranches(WT), 'listLocalBranches', [WT, {}]],
  [
    'getBranchCompare default tier',
    (p) => p.getBranchCompare(WT, 'main'),
    'getBranchCompare',
    [WT, 'main', interactive]
  ],
  [
    'getBranchCompare background',
    (p) => p.getBranchCompare(WT, 'main', { admissionTier: 'background' }),
    'getBranchCompare',
    [WT, 'main', { admissionTier: 'background' }]
  ],
  [
    'getCommitCompare',
    (p) => p.getCommitCompare(WT, 'abc'),
    'getCommitCompare',
    [WT, 'abc', interactive]
  ],
  [
    'getCommitDiff',
    (p) => p.getCommitDiff(WT, { commitOid: 'abc', filePath: 'a' }),
    'getCommitDiff',
    [WT, { commitOid: 'abc', filePath: 'a' }, interactive]
  ],
  [
    'getUpstreamStatus',
    (p) => p.getUpstreamStatus(WT, pushTarget),
    'getUpstreamStatus',
    [WT, pushTarget, {}]
  ],
  [
    'pushBranch',
    (p) => p.pushBranch(WT, true, pushTarget, { forceWithLease: true }),
    'gitPush',
    [WT, true, pushTarget, { forceWithLease: true, ...interactive }]
  ],
  [
    'pushBranch defaults',
    (p) => p.pushBranch(WT),
    'gitPush',
    [WT, false, undefined, { forceWithLease: false, ...interactive }]
  ],
  ['pullBranch', (p) => p.pullBranch(WT, pushTarget), 'gitPull', [WT, pushTarget, interactive]],
  [
    'fastForwardBranch',
    (p) => p.fastForwardBranch(WT, pushTarget),
    'gitFastForward',
    [WT, pushTarget, interactive]
  ],
  [
    'rebaseFromBase',
    (p) => p.rebaseFromBase(WT, 'main'),
    'gitPullRebaseFromBase',
    [WT, 'main', interactive]
  ],
  ['fetchRemote', (p) => p.fetchRemote(WT), 'gitFetch', [WT, undefined, interactive]],
  [
    'syncForkDefaultBranch',
    (p) => p.syncForkDefaultBranch(WT, { owner: 'acme', repo: 'orca' }),
    'gitSyncForkDefaultBranch',
    [WT, { owner: 'acme', repo: 'orca' }, interactive]
  ],
  ['listWorktrees', (p) => p.listWorktrees('/repo'), 'listWorktrees', ['/repo', {}]],
  [
    'exec',
    (p) => p.exec(['status'], WT, { timeoutMs: 5 }),
    'gitExecFileAsync',
    [['status'], { cwd: WT, timeout: 5 }]
  ],
  ['getRemoteFileUrl', (p) => p.getRemoteFileUrl(WT, 'a', 3), 'getRemoteFileUrl', [WT, 'a', 3]],
  ['getRemoteCommitUrl', (p) => p.getRemoteCommitUrl(WT, 'abc'), 'getRemoteCommitUrl', [WT, 'abc']]
]

describe('createLocalGitProvider', () => {
  beforeEach(() => {
    for (const fn of Object.values(git)) {
      fn.mockReset()
    }
  })

  it.each(cases)('%s calls the local free function as the runtime local arm does', async (...c) => {
    const [, call, fnName, expected] = c
    await call(createLocalGitProvider())
    expect(git[fnName]).toHaveBeenCalledTimes(1)
    expect(git[fnName]).toHaveBeenCalledWith(...expected)
  })

  it.each(cases)('%s keeps the WSL distro on every call', async (...c) => {
    const [, call, fnName] = c
    await call(createLocalGitProvider({ wslDistro: 'Ubuntu' }))
    const args = git[fnName].mock.calls[0]
    const options = args.at(-1)
    if (fnName === 'getRemoteFileUrl' || fnName === 'getRemoteCommitUrl') {
      // These read the Windows-hosted git directly, exactly as the local arm does today.
      expect(git.awaitWindowsHostGitEnvironmentReady).toHaveBeenCalledWith({ cwd: WT })
      return
    }
    expect(options).toMatchObject({ wslDistro: 'Ubuntu' })
  })

  it('applies shared link paths to status and scoped stage-all only', async () => {
    const getSharedLinkPaths = vi.fn(() => ['node_modules'])
    const provider = createLocalGitProvider({ getSharedLinkPaths })
    await provider.getDiff(WT, 'a', false)
    expect(getSharedLinkPaths).not.toHaveBeenCalled()
    await provider.getStatus(WT)
    await provider.bulkStageFiles(WT, [], 'all')
    await provider.bulkStageFiles(WT, ['a'])
    expect(git.getStatus).toHaveBeenCalledWith(WT, {
      admissionTier: 'status',
      sharedLinkPaths: ['node_modules']
    })
    expect(git.stageWorktreeChanges).toHaveBeenCalledWith(WT, 'all', {
      ...interactive,
      sharedLinkPaths: ['node_modules']
    })
    expect(git.bulkStageFiles).toHaveBeenCalledWith(WT, ['a'], interactive)
  })

  it('lets the per-call status tier win over a caller-wide default tier', async () => {
    await createLocalGitProvider({ admissionTier: 'background' }).getStatus(WT)
    expect(git.getStatus).toHaveBeenCalledWith(WT, { admissionTier: 'status' })
  })

  it('passes errors from the free function through unchanged', async () => {
    const error = new Error('fatal: not a git repository')
    git.getStatus.mockRejectedValueOnce(error)
    await expect(createLocalGitProvider().getStatus('/not-git')).rejects.toBe(error)
  })
})
