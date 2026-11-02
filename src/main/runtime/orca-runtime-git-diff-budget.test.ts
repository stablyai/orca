import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../shared/remote-rpc-content-budget'
import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as GitStatusModule from '../git/status'
import { RuntimeGitCommands } from './orca-runtime-git'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'

const mocks = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getBranchDiff: vi.fn(),
  getCommitDiff: vi.fn()
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  getDiff: mocks.getDiff,
  getBranchDiff: mocks.getBranchDiff,
  getCommitDiff: mocks.getCommitDiff
}))

const OVERSIZED_BASE64 = 'A'.repeat(REMOTE_RPC_MAX_CONTENT_BYTES + 1)
const BRANCH_COMPARE = { mergeBase: 'base-oid', headOid: 'head-oid' }
const COMMIT_ARGS = {
  commitOid: 'commit-oid',
  parentOid: 'parent-oid',
  filePath: 'assets/logo.png'
}
const TOO_LARGE = { code: 'diff_too_large', data: { maxBytes: REMOTE_RPC_MAX_CONTENT_BYTES } }

function oversizedResult(): GitDiffResult {
  return {
    kind: 'binary',
    originalContent: '',
    modifiedContent: OVERSIZED_BASE64,
    originalIsBinary: false,
    modifiedIsBinary: true
  }
}

function commands(localGitOptions?: { wslDistro: string }): RuntimeGitCommands {
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/remote/repo',
    git: { path: '/remote/repo', branch: 'main', isBare: false, isMainWorktree: false }
  } as unknown as ResolvedRuntimeGitWorktree
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({
      worktree,
      executionHostId: 'local' as const,
      ...(localGitOptions ? { localGitOptions } : {})
    }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('runtime git diff transport budget', () => {
  beforeEach(() => {
    mocks.getDiff.mockReset().mockResolvedValue(oversizedResult())
    mocks.getBranchDiff.mockReset().mockResolvedValue(oversizedResult())
    mocks.getCommitDiff.mockReset().mockResolvedValue(oversizedResult())
  })

  it('caps a local-repo diff that exceeds the budget', async () => {
    await expect(
      commands().getRuntimeGitDiff(
        'id:wt-1',
        'assets/logo.png',
        false,
        undefined,
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    ).rejects.toMatchObject(TOO_LARGE)
    expect(mocks.getDiff).toHaveBeenCalled()
  })

  it('caps a local-repo branch diff that exceeds the budget', async () => {
    await expect(
      commands().getRuntimeGitBranchDiff(
        'id:wt-1',
        BRANCH_COMPARE,
        'assets/logo.png',
        undefined,
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    ).rejects.toMatchObject(TOO_LARGE)
    expect(mocks.getBranchDiff).toHaveBeenCalled()
  })

  it('caps a local-repo commit diff that exceeds the budget', async () => {
    await expect(
      commands().getRuntimeGitCommitDiff('id:wt-1', COMMIT_ARGS, REMOTE_RPC_MAX_CONTENT_BYTES)
    ).rejects.toMatchObject(TOO_LARGE)
    expect(mocks.getCommitDiff).toHaveBeenCalled()
  })
})
