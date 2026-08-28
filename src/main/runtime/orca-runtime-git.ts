import { RuntimeGitDiffCommands } from './runtime-git-diff-commands'
import { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'
import { RuntimeGitStagingCommands } from './runtime-git-staging-commands'
import { RuntimeGitStatusCommands } from './runtime-git-status-commands'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

export type {
  ResolvedRuntimeGitWorktree,
  RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitCommands {
  readonly getRuntimeGitStatus: RuntimeGitStatusCommands['getRuntimeGitStatus']
  readonly getRuntimeGitSubmoduleStatus: RuntimeGitStatusCommands['getRuntimeGitSubmoduleStatus']
  readonly checkRuntimeGitIgnoredPaths: RuntimeGitStatusCommands['checkRuntimeGitIgnoredPaths']
  readonly getRuntimeGitHistory: RuntimeGitStatusCommands['getRuntimeGitHistory']
  readonly getRuntimeGitConflictOperation: RuntimeGitStatusCommands['getRuntimeGitConflictOperation']
  readonly checkoutRuntimeGitBranch: RuntimeGitStatusCommands['checkoutRuntimeGitBranch']
  readonly listRuntimeGitLocalBranches: RuntimeGitStatusCommands['listRuntimeGitLocalBranches']
  readonly getRuntimeGitDiff: RuntimeGitDiffCommands['getRuntimeGitDiff']
  readonly getRuntimeGitBranchCompare: RuntimeGitDiffCommands['getRuntimeGitBranchCompare']
  readonly getRuntimeGitCommitCompare: RuntimeGitDiffCommands['getRuntimeGitCommitCompare']
  readonly getRuntimeGitBranchDiff: RuntimeGitDiffCommands['getRuntimeGitBranchDiff']
  readonly getRuntimeGitCommitDiff: RuntimeGitDiffCommands['getRuntimeGitCommitDiff']
  readonly getRuntimeGitRemoteFileUrl: RuntimeGitDiffCommands['getRuntimeGitRemoteFileUrl']
  readonly getRuntimeGitRemoteCommitUrl: RuntimeGitDiffCommands['getRuntimeGitRemoteCommitUrl']
  readonly abortRuntimeGitMerge: RuntimeGitSyncCommands['abortRuntimeGitMerge']
  readonly abortRuntimeGitRebase: RuntimeGitSyncCommands['abortRuntimeGitRebase']
  readonly getRuntimeGitUpstreamStatus: RuntimeGitSyncCommands['getRuntimeGitUpstreamStatus']
  readonly fetchRuntimeGit: RuntimeGitSyncCommands['fetchRuntimeGit']
  readonly syncRuntimeGitForkDefaultBranch: RuntimeGitSyncCommands['syncRuntimeGitForkDefaultBranch']
  readonly pullRuntimeGit: RuntimeGitSyncCommands['pullRuntimeGit']
  readonly fastForwardRuntimeGit: RuntimeGitSyncCommands['fastForwardRuntimeGit']
  readonly rebaseRuntimeGitFromBase: RuntimeGitSyncCommands['rebaseRuntimeGitFromBase']
  readonly pushRuntimeGit: RuntimeGitSyncCommands['pushRuntimeGit']
  readonly commitRuntimeGit: RuntimeGitSyncCommands['commitRuntimeGit']
  readonly generateRuntimeCommitMessage: RuntimeGitGenerationCommands['generateRuntimeCommitMessage']
  readonly cancelRuntimeGenerateCommitMessage: RuntimeGitGenerationCommands['cancelRuntimeGenerateCommitMessage']
  readonly generateRuntimePullRequestFields: RuntimeGitGenerationCommands['generateRuntimePullRequestFields']
  readonly cancelRuntimeGeneratePullRequestFields: RuntimeGitGenerationCommands['cancelRuntimeGeneratePullRequestFields']
  readonly discoverRuntimeCommitMessageModels: RuntimeGitGenerationCommands['discoverRuntimeCommitMessageModels']
  readonly stageRuntimeGitPath: RuntimeGitStagingCommands['stageRuntimeGitPath']
  readonly unstageRuntimeGitPath: RuntimeGitStagingCommands['unstageRuntimeGitPath']
  readonly bulkStageRuntimeGitPaths: RuntimeGitStagingCommands['bulkStageRuntimeGitPaths']
  readonly bulkUnstageRuntimeGitPaths: RuntimeGitStagingCommands['bulkUnstageRuntimeGitPaths']
  readonly bulkDiscardRuntimeGitPaths: RuntimeGitStagingCommands['bulkDiscardRuntimeGitPaths']
  readonly discardRuntimeGitPath: RuntimeGitStagingCommands['discardRuntimeGitPath']

  constructor(host: RuntimeGitCommandHost) {
    const status = new RuntimeGitStatusCommands(host)
    const diff = new RuntimeGitDiffCommands(host)
    const sync = new RuntimeGitSyncCommands(host)
    const generation = new RuntimeGitGenerationCommands(host)
    const staging = new RuntimeGitStagingCommands(host)

    this.getRuntimeGitStatus = status.getRuntimeGitStatus.bind(status)
    this.getRuntimeGitSubmoduleStatus = status.getRuntimeGitSubmoduleStatus.bind(status)
    this.checkRuntimeGitIgnoredPaths = status.checkRuntimeGitIgnoredPaths.bind(status)
    this.getRuntimeGitHistory = status.getRuntimeGitHistory.bind(status)
    this.getRuntimeGitConflictOperation = status.getRuntimeGitConflictOperation.bind(status)
    this.checkoutRuntimeGitBranch = status.checkoutRuntimeGitBranch.bind(status)
    this.listRuntimeGitLocalBranches = status.listRuntimeGitLocalBranches.bind(status)
    this.getRuntimeGitDiff = diff.getRuntimeGitDiff.bind(diff)
    this.getRuntimeGitBranchCompare = diff.getRuntimeGitBranchCompare.bind(diff)
    this.getRuntimeGitCommitCompare = diff.getRuntimeGitCommitCompare.bind(diff)
    this.getRuntimeGitBranchDiff = diff.getRuntimeGitBranchDiff.bind(diff)
    this.getRuntimeGitCommitDiff = diff.getRuntimeGitCommitDiff.bind(diff)
    this.getRuntimeGitRemoteFileUrl = diff.getRuntimeGitRemoteFileUrl.bind(diff)
    this.getRuntimeGitRemoteCommitUrl = diff.getRuntimeGitRemoteCommitUrl.bind(diff)
    this.abortRuntimeGitMerge = sync.abortRuntimeGitMerge.bind(sync)
    this.abortRuntimeGitRebase = sync.abortRuntimeGitRebase.bind(sync)
    this.getRuntimeGitUpstreamStatus = sync.getRuntimeGitUpstreamStatus.bind(sync)
    this.fetchRuntimeGit = sync.fetchRuntimeGit.bind(sync)
    this.syncRuntimeGitForkDefaultBranch = sync.syncRuntimeGitForkDefaultBranch.bind(sync)
    this.pullRuntimeGit = sync.pullRuntimeGit.bind(sync)
    this.fastForwardRuntimeGit = sync.fastForwardRuntimeGit.bind(sync)
    this.rebaseRuntimeGitFromBase = sync.rebaseRuntimeGitFromBase.bind(sync)
    this.pushRuntimeGit = sync.pushRuntimeGit.bind(sync)
    this.commitRuntimeGit = sync.commitRuntimeGit.bind(sync)
    this.generateRuntimeCommitMessage = generation.generateRuntimeCommitMessage.bind(generation)
    this.cancelRuntimeGenerateCommitMessage =
      generation.cancelRuntimeGenerateCommitMessage.bind(generation)
    this.generateRuntimePullRequestFields =
      generation.generateRuntimePullRequestFields.bind(generation)
    this.cancelRuntimeGeneratePullRequestFields =
      generation.cancelRuntimeGeneratePullRequestFields.bind(generation)
    this.discoverRuntimeCommitMessageModels =
      generation.discoverRuntimeCommitMessageModels.bind(generation)
    this.stageRuntimeGitPath = staging.stageRuntimeGitPath.bind(staging)
    this.unstageRuntimeGitPath = staging.unstageRuntimeGitPath.bind(staging)
    this.bulkStageRuntimeGitPaths = staging.bulkStageRuntimeGitPaths.bind(staging)
    this.bulkUnstageRuntimeGitPaths = staging.bulkUnstageRuntimeGitPaths.bind(staging)
    this.bulkDiscardRuntimeGitPaths = staging.bulkDiscardRuntimeGitPaths.bind(staging)
    this.discardRuntimeGitPath = staging.discardRuntimeGitPath.bind(staging)
  }
}
