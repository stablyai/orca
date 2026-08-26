import { describe, expect, it } from 'vitest'
import type { IGitProvider } from './types'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux } from './ssh-git-provider-test-harness'

describe('SshGitProvider public API parity', () => {
  it('retains every historical provider operation', () => {
    const provider: IGitProvider & SshGitProvider = new SshGitProvider(
      'conn-1',
      createMockMux() as never
    )
    const methods = [
      'getConnectionId',
      'getHostPlatform',
      'getStatus',
      'getSubmoduleStatus',
      'checkIgnoredPaths',
      'getHistory',
      'commit',
      'getStagedCommitContext',
      'executeCommitMessagePlan',
      'execNonInteractive',
      'cancelNonInteractiveExec',
      'cancelGenerateCommitMessage',
      'getDiff',
      'stageFile',
      'unstageFile',
      'bulkStageFiles',
      'bulkUnstageFiles',
      'discardChanges',
      'bulkDiscardChanges',
      'detectConflictOperation',
      'abortMerge',
      'abortRebase',
      'checkoutBranch',
      'listLocalBranches',
      'getBranchCompare',
      'getCommitCompare',
      'getUpstreamStatus',
      'pushBranch',
      'pullBranch',
      'fastForwardBranch',
      'rebaseFromBase',
      'fetchRemote',
      'syncForkDefaultBranch',
      'fetchRemoteTrackingRef',
      'fetchGitLabMergeRequestHead',
      'fetchGitHubPullRequestHead',
      'getBranchDiff',
      'getCommitDiff',
      'listWorktrees',
      'addWorktree',
      'removeWorktree',
      'worktreeIsClean',
      'refreshLocalBaseRefForWorktreeCreate',
      'renameCurrentBranch',
      'forceDeletePreservedBranch',
      'exec',
      'clone',
      'isGitRepoAsync',
      'isGitRepo',
      'getRemoteFileUrl',
      'getRemoteCommitUrl'
    ] as const

    expect(methods).toHaveLength(51)
    for (const method of methods) {
      expect(provider[method], method).toBeTypeOf('function')
    }
  })
})
