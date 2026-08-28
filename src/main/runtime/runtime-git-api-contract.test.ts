import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { GIT_METHODS } from './rpc/methods/git'
import { RuntimeGitCommands } from './orca-runtime-git'

const RPC_TO_RUNTIME_COMMAND = {
  'git.status': 'getRuntimeGitStatus',
  'git.checkIgnored': 'checkRuntimeGitIgnoredPaths',
  'git.submoduleStatus': 'getRuntimeGitSubmoduleStatus',
  'git.history': 'getRuntimeGitHistory',
  'git.conflictOperation': 'getRuntimeGitConflictOperation',
  'git.abortMerge': 'abortRuntimeGitMerge',
  'git.abortRebase': 'abortRuntimeGitRebase',
  'git.checkout': 'checkoutRuntimeGitBranch',
  'git.localBranches': 'listRuntimeGitLocalBranches',
  'git.diff': 'getRuntimeGitDiff',
  'git.branchDiff': 'getRuntimeGitBranchDiff',
  'git.commitDiff': 'getRuntimeGitCommitDiff',
  'git.branchCompare': 'getRuntimeGitBranchCompare',
  'git.commitCompare': 'getRuntimeGitCommitCompare',
  'git.upstreamStatus': 'getRuntimeGitUpstreamStatus',
  'git.fetch': 'fetchRuntimeGit',
  'git.forkSync': 'syncRuntimeGitForkDefaultBranch',
  'git.pull': 'pullRuntimeGit',
  'git.fastForward': 'fastForwardRuntimeGit',
  'git.rebaseFromBase': 'rebaseRuntimeGitFromBase',
  'git.push': 'pushRuntimeGit',
  'git.commit': 'commitRuntimeGit',
  'git.generateCommitMessage': 'generateRuntimeCommitMessage',
  'git.discoverCommitMessageModels': 'discoverRuntimeCommitMessageModels',
  'git.cancelGenerateCommitMessage': 'cancelRuntimeGenerateCommitMessage',
  'git.generatePullRequestFields': 'generateRuntimePullRequestFields',
  'git.cancelGeneratePullRequestFields': 'cancelRuntimeGeneratePullRequestFields',
  'git.stage': 'stageRuntimeGitPath',
  'git.bulkStage': 'bulkStageRuntimeGitPaths',
  'git.unstage': 'unstageRuntimeGitPath',
  'git.bulkUnstage': 'bulkUnstageRuntimeGitPaths',
  'git.discard': 'discardRuntimeGitPath',
  'git.bulkDiscard': 'bulkDiscardRuntimeGitPaths',
  'git.remoteFileUrl': 'getRuntimeGitRemoteFileUrl',
  'git.remoteCommitUrl': 'getRuntimeGitRemoteCommitUrl'
} as const satisfies Record<string, keyof RuntimeGitCommands>

describe('runtime Git API contract', () => {
  it('keeps every registered Git RPC paired with one public runtime command', () => {
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => {
        throw new Error('not called')
      },
      getRuntimeSettings: () => ({}) as GlobalSettings
    })
    const registeredMethods = GIT_METHODS.map((method) => method.name).sort()

    expect(registeredMethods).toEqual(Object.keys(RPC_TO_RUNTIME_COMMAND).sort())
    for (const commandName of Object.values(RPC_TO_RUNTIME_COMMAND)) {
      expect(commands[commandName]).toBeTypeOf('function')
    }
  })
})
