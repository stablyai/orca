// Why: the cap lives in orca-runtime-git.ts so both branches of all three diff readers are covered —
// an SSH host forwards its provider's payload verbatim, so an older relay cannot be relied on to clamp it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../shared/remote-rpc-content-budget'
import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as GitStatusModule from '../git/status'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  getSshGitProvider: vi.fn(),
  getDiff: vi.fn(),
  getBranchDiff: vi.fn(),
  getCommitDiff: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
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

function commands(connectionId?: string): RuntimeGitCommands {
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/remote/repo',
    git: { path: '/remote/repo', branch: 'main', isBare: false, isMainWorktree: false }
  } as unknown as ResolvedRuntimeGitWorktree
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({
      worktree,
      ...(connectionId ? { connectionId } : {})
    }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

function sshProvider(): {
  getDiff: ReturnType<typeof vi.fn>
  getBranchDiff: ReturnType<typeof vi.fn>
  getCommitDiff: ReturnType<typeof vi.fn>
} {
  return {
    getDiff: vi.fn().mockResolvedValue(oversizedResult()),
    getBranchDiff: vi.fn().mockResolvedValue([oversizedResult()]),
    getCommitDiff: vi.fn().mockResolvedValue(oversizedResult())
  }
}

describe('runtime git diff transport budget', () => {
  beforeEach(() => {
    mocks.getSshGitProvider.mockReset()
    mocks.getDiff.mockReset().mockResolvedValue(oversizedResult())
    mocks.getBranchDiff.mockReset().mockResolvedValue(oversizedResult())
    mocks.getCommitDiff.mockReset().mockResolvedValue(oversizedResult())
  })

  it('caps an SSH-forwarded diff that exceeds the budget', async () => {
    const provider = sshProvider()
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      commands('conn-1').getRuntimeGitDiff(
        'id:wt-1',
        'assets/logo.png',
        false,
        undefined,
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    ).rejects.toMatchObject(TOO_LARGE)
    expect(provider.getDiff).toHaveBeenCalledWith(
      '/remote/repo',
      'assets/logo.png',
      false,
      undefined
    )
    expect(mocks.getDiff).not.toHaveBeenCalled()
  })

  it('leaves an SSH-forwarded diff uncapped when no budget is supplied', async () => {
    mocks.getSshGitProvider.mockReturnValue(sshProvider())

    await expect(
      commands('conn-1').getRuntimeGitDiff('id:wt-1', 'assets/logo.png', false)
    ).resolves.toMatchObject({ modifiedContent: OVERSIZED_BASE64 })
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
    expect(mocks.getSshGitProvider).not.toHaveBeenCalled()
  })

  it('leaves a local-repo diff uncapped when no budget is supplied', async () => {
    await expect(
      commands().getRuntimeGitDiff('id:wt-1', 'assets/logo.png', false)
    ).resolves.toMatchObject({ modifiedContent: OVERSIZED_BASE64 })
  })

  it('caps an SSH-forwarded branch diff that exceeds the budget', async () => {
    const provider = sshProvider()
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      commands('conn-1').getRuntimeGitBranchDiff(
        'id:wt-1',
        BRANCH_COMPARE,
        'assets/logo.png',
        undefined,
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    ).rejects.toMatchObject(TOO_LARGE)
    expect(provider.getBranchDiff).toHaveBeenCalled()
    expect(mocks.getBranchDiff).not.toHaveBeenCalled()
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

  it('leaves a local-repo branch diff uncapped when no budget is supplied', async () => {
    await expect(
      commands().getRuntimeGitBranchDiff('id:wt-1', BRANCH_COMPARE, 'assets/logo.png')
    ).resolves.toMatchObject({ modifiedContent: OVERSIZED_BASE64 })
  })

  it('caps an SSH-forwarded commit diff that exceeds the budget', async () => {
    const provider = sshProvider()
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      commands('conn-1').getRuntimeGitCommitDiff(
        'id:wt-1',
        COMMIT_ARGS,
        REMOTE_RPC_MAX_CONTENT_BYTES
      )
    ).rejects.toMatchObject(TOO_LARGE)
    expect(provider.getCommitDiff).toHaveBeenCalled()
    expect(mocks.getCommitDiff).not.toHaveBeenCalled()
  })

  it('caps a local-repo commit diff that exceeds the budget', async () => {
    await expect(
      commands().getRuntimeGitCommitDiff('id:wt-1', COMMIT_ARGS, REMOTE_RPC_MAX_CONTENT_BYTES)
    ).rejects.toMatchObject(TOO_LARGE)
    expect(mocks.getCommitDiff).toHaveBeenCalled()
  })

  it('leaves a local-repo commit diff uncapped when no budget is supplied', async () => {
    await expect(commands().getRuntimeGitCommitDiff('id:wt-1', COMMIT_ARGS)).resolves.toMatchObject(
      {
        modifiedContent: OVERSIZED_BASE64
      }
    )
  })
})
