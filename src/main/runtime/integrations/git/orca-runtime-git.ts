import type { RuntimeGitDiffCommands } from './runtime-git-diff-commands'
import type { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'
import type { RuntimeGitStagingCommands } from './runtime-git-staging-commands'
import type { RuntimeGitStatusCommands } from './runtime-git-status-commands'
import type { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

function lazyInstance<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null
  return () => {
    if (!promise) {
      promise = factory().catch((error: unknown) => {
        promise = null
        throw error
      })
    }
    return promise
  }
}

export class RuntimeGitCommands {
  readonly getRuntimeGitStatus: RuntimeGitStatusCommands['getRuntimeGitStatus']
  readonly getRuntimeGitSubmoduleStatus: RuntimeGitStatusCommands['getRuntimeGitSubmoduleStatus']
  readonly checkRuntimeGitIgnoredPaths: RuntimeGitStatusCommands['checkRuntimeGitIgnoredPaths']
  readonly getRuntimeGitRefs: RuntimeGitStatusCommands['getRuntimeGitRefs']
  readonly getRuntimeGitHistory: RuntimeGitStatusCommands['getRuntimeGitHistory']
  readonly getRuntimeGitConflictOperation: RuntimeGitStatusCommands['getRuntimeGitConflictOperation']
  readonly getRuntimeGitMutationInFlight: RuntimeGitStatusCommands['getRuntimeGitMutationInFlight']
  readonly readRuntimeWorktreeAtRiskLocalFiles: RuntimeGitStatusCommands['readRuntimeWorktreeAtRiskLocalFiles']
  readonly switchRuntimeGitBranch: RuntimeGitStatusCommands['switchRuntimeGitBranch']
  readonly checkoutRuntimeGitBranch: RuntimeGitStatusCommands['checkoutRuntimeGitBranch']
  readonly listRuntimeGitLocalBranches: RuntimeGitStatusCommands['listRuntimeGitLocalBranches']
  readonly getRuntimeGitDiff: RuntimeGitDiffCommands['getRuntimeGitDiff']
  readonly getRuntimeGitBranchCompare: RuntimeGitDiffCommands['getRuntimeGitBranchCompare']
  readonly getRuntimeGitCommitCompare: RuntimeGitDiffCommands['getRuntimeGitCommitCompare']
  readonly getRuntimeGitBranchDiff: RuntimeGitDiffCommands['getRuntimeGitBranchDiff']
  readonly getRuntimeGitCommitDiff: RuntimeGitDiffCommands['getRuntimeGitCommitDiff']
  readonly getRuntimeGitRemoteFileUrl: RuntimeGitDiffCommands['getRuntimeGitRemoteFileUrl']
  readonly getRuntimeGitRemoteCommitUrl: RuntimeGitDiffCommands['getRuntimeGitRemoteCommitUrl']
  readonly getRuntimeGitBlame: RuntimeGitDiffCommands['getRuntimeGitBlame']
  readonly abortRuntimeGitMerge: RuntimeGitSyncCommands['abortRuntimeGitMerge']
  readonly abortRuntimeGitRebase: RuntimeGitSyncCommands['abortRuntimeGitRebase']
  readonly continueRuntimeGitRebase: RuntimeGitSyncCommands['continueRuntimeGitRebase']
  readonly readRuntimeGitRebaseAutoStash: RuntimeGitSyncCommands['readRuntimeGitRebaseAutoStash']
  readonly getRuntimeGitUpstreamStatus: RuntimeGitSyncCommands['getRuntimeGitUpstreamStatus']
  readonly fetchRuntimeGit: RuntimeGitSyncCommands['fetchRuntimeGit']
  readonly syncRuntimeGitForkDefaultBranch: RuntimeGitSyncCommands['syncRuntimeGitForkDefaultBranch']
  readonly pullRuntimeGit: RuntimeGitSyncCommands['pullRuntimeGit']
  readonly fastForwardRuntimeGit: RuntimeGitSyncCommands['fastForwardRuntimeGit']
  readonly rebaseRuntimeGitFromBase: RuntimeGitSyncCommands['rebaseRuntimeGitFromBase']
  readonly pushRuntimeGit: RuntimeGitSyncCommands['pushRuntimeGit']
  readonly commitRuntimeGit: RuntimeGitSyncCommands['commitRuntimeGit']
  readonly createRuntimeGitBranch: RuntimeGitSyncCommands['createRuntimeGitBranch']
  readonly cherryPickRuntimeGit: RuntimeGitSyncCommands['cherryPickRuntimeGit']
  readonly revertRuntimeGit: RuntimeGitSyncCommands['revertRuntimeGit']
  readonly sequencerAbortRuntimeGit: RuntimeGitSyncCommands['sequencerAbortRuntimeGit']
  readonly sequencerContinueRuntimeGit: RuntimeGitSyncCommands['sequencerContinueRuntimeGit']
  readonly completeRuntimeGitMerge: RuntimeGitSyncCommands['completeRuntimeGitMerge']
  readonly generateRuntimeCommitMessage: RuntimeGitGenerationCommands['generateRuntimeCommitMessage']
  readonly cancelRuntimeGenerateCommitMessage: RuntimeGitGenerationCommands['cancelRuntimeGenerateCommitMessage']
  readonly generateRuntimePullRequestFields: RuntimeGitGenerationCommands['generateRuntimePullRequestFields']
  readonly cancelRuntimeGeneratePullRequestFields: RuntimeGitGenerationCommands['cancelRuntimeGeneratePullRequestFields']
  readonly discoverRuntimeCommitMessageModels: RuntimeGitGenerationCommands['discoverRuntimeCommitMessageModels']
  readonly stageRuntimeGitPath: RuntimeGitStagingCommands['stageRuntimeGitPath']
  readonly resolveRuntimeGitConflict: RuntimeGitStagingCommands['resolveRuntimeGitConflict']
  readonly unstageRuntimeGitPath: RuntimeGitStagingCommands['unstageRuntimeGitPath']
  readonly bulkStageRuntimeGitPaths: RuntimeGitStagingCommands['bulkStageRuntimeGitPaths']
  readonly bulkUnstageRuntimeGitPaths: RuntimeGitStagingCommands['bulkUnstageRuntimeGitPaths']
  readonly bulkDiscardRuntimeGitPaths: RuntimeGitStagingCommands['bulkDiscardRuntimeGitPaths']
  readonly discardRuntimeGitPath: RuntimeGitStagingCommands['discardRuntimeGitPath']

  constructor(host: RuntimeGitCommandHost) {
    const getStatus = lazyInstance(() =>
      import('./runtime-git-status-commands').then(
        ({ RuntimeGitStatusCommands: Ctor }) => new Ctor(host)
      )
    )
    const getDiff = lazyInstance(() =>
      import('./runtime-git-diff-commands').then(
        ({ RuntimeGitDiffCommands: Ctor }) => new Ctor(host)
      )
    )
    const getSync = lazyInstance(() =>
      import('./runtime-git-sync-commands').then(
        ({ RuntimeGitSyncCommands: Ctor }) => new Ctor(host)
      )
    )
    const getGeneration = lazyInstance(() =>
      import('./runtime-git-generation-commands').then(
        ({ RuntimeGitGenerationCommands: Ctor }) => new Ctor(host)
      )
    )
    const getStaging = lazyInstance(() =>
      import('./runtime-git-staging-commands').then(
        ({ RuntimeGitStagingCommands: Ctor }) => new Ctor(host)
      )
    )

    this.getRuntimeGitStatus = async (...args) => (await getStatus()).getRuntimeGitStatus(...args)
    this.getRuntimeGitSubmoduleStatus = async (...args) =>
      (await getStatus()).getRuntimeGitSubmoduleStatus(...args)
    this.checkRuntimeGitIgnoredPaths = async (...args) =>
      (await getStatus()).checkRuntimeGitIgnoredPaths(...args)
    this.getRuntimeGitRefs = async (...args) => (await getStatus()).getRuntimeGitRefs(...args)
    this.getRuntimeGitHistory = async (...args) => (await getStatus()).getRuntimeGitHistory(...args)
    this.getRuntimeGitConflictOperation = async (...args) =>
      (await getStatus()).getRuntimeGitConflictOperation(...args)
    this.getRuntimeGitMutationInFlight = async (...args) =>
      (await getStatus()).getRuntimeGitMutationInFlight(...args)
    this.readRuntimeWorktreeAtRiskLocalFiles = async (...args) =>
      (await getStatus()).readRuntimeWorktreeAtRiskLocalFiles(...args)
    this.switchRuntimeGitBranch = async (...args) =>
      (await getStatus()).switchRuntimeGitBranch(...args)
    this.checkoutRuntimeGitBranch = async (...args) =>
      (await getStatus()).checkoutRuntimeGitBranch(...args)
    this.listRuntimeGitLocalBranches = async (...args) =>
      (await getStatus()).listRuntimeGitLocalBranches(...args)

    this.getRuntimeGitDiff = async (...args) => (await getDiff()).getRuntimeGitDiff(...args)
    this.getRuntimeGitBranchCompare = async (...args) =>
      (await getDiff()).getRuntimeGitBranchCompare(...args)
    this.getRuntimeGitCommitCompare = async (...args) =>
      (await getDiff()).getRuntimeGitCommitCompare(...args)
    this.getRuntimeGitBranchDiff = async (...args) =>
      (await getDiff()).getRuntimeGitBranchDiff(...args)
    this.getRuntimeGitCommitDiff = async (...args) =>
      (await getDiff()).getRuntimeGitCommitDiff(...args)
    this.getRuntimeGitRemoteFileUrl = async (...args) =>
      (await getDiff()).getRuntimeGitRemoteFileUrl(...args)
    this.getRuntimeGitRemoteCommitUrl = async (...args) =>
      (await getDiff()).getRuntimeGitRemoteCommitUrl(...args)
    this.getRuntimeGitBlame = async (...args) => (await getDiff()).getRuntimeGitBlame(...args)

    this.abortRuntimeGitMerge = async (...args) => (await getSync()).abortRuntimeGitMerge(...args)
    this.abortRuntimeGitRebase = async (...args) => (await getSync()).abortRuntimeGitRebase(...args)
    this.continueRuntimeGitRebase = async (...args) =>
      (await getSync()).continueRuntimeGitRebase(...args)
    this.readRuntimeGitRebaseAutoStash = async (...args) =>
      (await getSync()).readRuntimeGitRebaseAutoStash(...args)
    this.getRuntimeGitUpstreamStatus = async (...args) =>
      (await getSync()).getRuntimeGitUpstreamStatus(...args)
    this.fetchRuntimeGit = async (...args) => (await getSync()).fetchRuntimeGit(...args)
    this.syncRuntimeGitForkDefaultBranch = async (...args) =>
      (await getSync()).syncRuntimeGitForkDefaultBranch(...args)
    this.pullRuntimeGit = async (...args) => (await getSync()).pullRuntimeGit(...args)
    this.fastForwardRuntimeGit = async (...args) => (await getSync()).fastForwardRuntimeGit(...args)
    this.rebaseRuntimeGitFromBase = async (...args) =>
      (await getSync()).rebaseRuntimeGitFromBase(...args)
    this.pushRuntimeGit = async (...args) => (await getSync()).pushRuntimeGit(...args)
    this.commitRuntimeGit = async (...args) => (await getSync()).commitRuntimeGit(...args)
    this.createRuntimeGitBranch = async (...args) =>
      (await getSync()).createRuntimeGitBranch(...args)
    this.cherryPickRuntimeGit = async (...args) => (await getSync()).cherryPickRuntimeGit(...args)
    this.revertRuntimeGit = async (...args) => (await getSync()).revertRuntimeGit(...args)
    this.sequencerAbortRuntimeGit = async (...args) =>
      (await getSync()).sequencerAbortRuntimeGit(...args)
    this.sequencerContinueRuntimeGit = async (...args) =>
      (await getSync()).sequencerContinueRuntimeGit(...args)
    this.completeRuntimeGitMerge = async (...args) =>
      (await getSync()).completeRuntimeGitMerge(...args)

    this.generateRuntimeCommitMessage = async (...args) =>
      (await getGeneration()).generateRuntimeCommitMessage(...args)
    this.cancelRuntimeGenerateCommitMessage = async (...args) =>
      (await getGeneration()).cancelRuntimeGenerateCommitMessage(...args)
    this.generateRuntimePullRequestFields = async (...args) =>
      (await getGeneration()).generateRuntimePullRequestFields(...args)
    this.cancelRuntimeGeneratePullRequestFields = async (...args) =>
      (await getGeneration()).cancelRuntimeGeneratePullRequestFields(...args)
    this.discoverRuntimeCommitMessageModels = async (...args) =>
      (await getGeneration()).discoverRuntimeCommitMessageModels(...args)

    this.stageRuntimeGitPath = async (...args) => (await getStaging()).stageRuntimeGitPath(...args)
    this.resolveRuntimeGitConflict = async (...args) =>
      (await getStaging()).resolveRuntimeGitConflict(...args)
    this.unstageRuntimeGitPath = async (...args) =>
      (await getStaging()).unstageRuntimeGitPath(...args)
    this.bulkStageRuntimeGitPaths = async (...args) =>
      (await getStaging()).bulkStageRuntimeGitPaths(...args)
    this.bulkUnstageRuntimeGitPaths = async (...args) =>
      (await getStaging()).bulkUnstageRuntimeGitPaths(...args)
    this.bulkDiscardRuntimeGitPaths = async (...args) =>
      (await getStaging()).bulkDiscardRuntimeGitPaths(...args)
    this.discardRuntimeGitPath = async (...args) =>
      (await getStaging()).discardRuntimeGitPath(...args)
  }
}
