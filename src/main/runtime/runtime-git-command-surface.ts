import type { RuntimeGitCommands } from './orca-runtime-git'

type RuntimeGitCommandName =
  | 'getRuntimeGitStatus'
  | 'getRuntimeGitSubmoduleStatus'
  | 'checkRuntimeGitIgnoredPaths'
  | 'getRuntimeGitHistory'
  | 'getRuntimeGitConflictOperation'
  | 'abortRuntimeGitMerge'
  | 'abortRuntimeGitRebase'
  | 'checkoutRuntimeGitBranch'
  | 'listRuntimeGitLocalBranches'
  | 'getRuntimeGitDiff'
  | 'getRuntimeGitBranchCompare'
  | 'getRuntimeGitCommitCompare'
  | 'getRuntimeGitUpstreamStatus'
  | 'fetchRuntimeGit'
  | 'syncRuntimeGitForkDefaultBranch'
  | 'pullRuntimeGit'
  | 'fastForwardRuntimeGit'
  | 'rebaseRuntimeGitFromBase'
  | 'pushRuntimeGit'
  | 'getRuntimeGitBranchDiff'
  | 'getRuntimeGitCommitDiff'
  | 'commitRuntimeGit'
  | 'generateRuntimeCommitMessage'
  | 'discoverRuntimeCommitMessageModels'
  | 'cancelRuntimeGenerateCommitMessage'
  | 'generateRuntimePullRequestFields'
  | 'cancelRuntimeGeneratePullRequestFields'
  | 'stageRuntimeGitPath'
  | 'unstageRuntimeGitPath'
  | 'bulkStageRuntimeGitPaths'
  | 'bulkUnstageRuntimeGitPaths'
  | 'bulkDiscardRuntimeGitPaths'
  | 'discardRuntimeGitPath'
  | 'getRuntimeGitRemoteFileUrl'
  | 'getRuntimeGitRemoteCommitUrl'

export type RuntimeGitCommandSurface = Pick<RuntimeGitCommands, RuntimeGitCommandName>

export function installRuntimeGitCommandSurface(
  target: RuntimeGitCommandSurface,
  commands: RuntimeGitCommands
): void {
  Object.assign(target, {
    getRuntimeGitStatus: commands.getRuntimeGitStatus.bind(commands),
    getRuntimeGitSubmoduleStatus: commands.getRuntimeGitSubmoduleStatus.bind(commands),
    checkRuntimeGitIgnoredPaths: commands.checkRuntimeGitIgnoredPaths.bind(commands),
    getRuntimeGitHistory: commands.getRuntimeGitHistory.bind(commands),
    getRuntimeGitConflictOperation: commands.getRuntimeGitConflictOperation.bind(commands),
    abortRuntimeGitMerge: commands.abortRuntimeGitMerge.bind(commands),
    abortRuntimeGitRebase: commands.abortRuntimeGitRebase.bind(commands),
    checkoutRuntimeGitBranch: commands.checkoutRuntimeGitBranch.bind(commands),
    listRuntimeGitLocalBranches: commands.listRuntimeGitLocalBranches.bind(commands),
    getRuntimeGitDiff: commands.getRuntimeGitDiff.bind(commands),
    getRuntimeGitBranchCompare: commands.getRuntimeGitBranchCompare.bind(commands),
    getRuntimeGitCommitCompare: commands.getRuntimeGitCommitCompare.bind(commands),
    getRuntimeGitUpstreamStatus: commands.getRuntimeGitUpstreamStatus.bind(commands),
    fetchRuntimeGit: commands.fetchRuntimeGit.bind(commands),
    syncRuntimeGitForkDefaultBranch: commands.syncRuntimeGitForkDefaultBranch.bind(commands),
    pullRuntimeGit: commands.pullRuntimeGit.bind(commands),
    fastForwardRuntimeGit: commands.fastForwardRuntimeGit.bind(commands),
    rebaseRuntimeGitFromBase: commands.rebaseRuntimeGitFromBase.bind(commands),
    pushRuntimeGit: commands.pushRuntimeGit.bind(commands),
    getRuntimeGitBranchDiff: commands.getRuntimeGitBranchDiff.bind(commands),
    getRuntimeGitCommitDiff: commands.getRuntimeGitCommitDiff.bind(commands),
    commitRuntimeGit: commands.commitRuntimeGit.bind(commands),
    generateRuntimeCommitMessage: commands.generateRuntimeCommitMessage.bind(commands),
    discoverRuntimeCommitMessageModels: commands.discoverRuntimeCommitMessageModels.bind(commands),
    cancelRuntimeGenerateCommitMessage: commands.cancelRuntimeGenerateCommitMessage.bind(commands),
    generateRuntimePullRequestFields: commands.generateRuntimePullRequestFields.bind(commands),
    cancelRuntimeGeneratePullRequestFields:
      commands.cancelRuntimeGeneratePullRequestFields.bind(commands),
    stageRuntimeGitPath: commands.stageRuntimeGitPath.bind(commands),
    unstageRuntimeGitPath: commands.unstageRuntimeGitPath.bind(commands),
    bulkStageRuntimeGitPaths: commands.bulkStageRuntimeGitPaths.bind(commands),
    bulkUnstageRuntimeGitPaths: commands.bulkUnstageRuntimeGitPaths.bind(commands),
    bulkDiscardRuntimeGitPaths: commands.bulkDiscardRuntimeGitPaths.bind(commands),
    discardRuntimeGitPath: commands.discardRuntimeGitPath.bind(commands),
    getRuntimeGitRemoteFileUrl: commands.getRuntimeGitRemoteFileUrl.bind(commands),
    getRuntimeGitRemoteCommitUrl: commands.getRuntimeGitRemoteCommitUrl.bind(commands)
  } satisfies RuntimeGitCommandSurface)
}
