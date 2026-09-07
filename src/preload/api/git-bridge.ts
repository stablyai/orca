import { ipcRenderer } from 'electron'
import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../shared/git-fork-sync'
import type { GitStagingArea, GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { PreloadApi } from '../api-types'

export const gitApi = {
  status: (args: {
    worktreePath: string
    connectionId?: string
    includeIgnored?: boolean
    bypassEffectiveUpstreamNegativeCache?: boolean
    reuseLineStats?: boolean
    branchLineTotalMergeBase?: string
    requestToken?: string
  }) => ipcRenderer.invoke('git:status', args),
  cancelStatus: (args: { requestToken: string }): Promise<void> =>
    ipcRenderer.invoke('git:cancelStatus', args),
  setStatusUpstreamRefWatch: (args: {
    worktreeId: string
    worktreePath: string
    executionHostId: string
    connectionId?: string
    branch?: string
    upstreamName?: string
  }): Promise<void> => ipcRenderer.invoke('git:setStatusUpstreamRefWatch', args),
  submoduleStatus: (args: {
    worktreePath: string
    submodulePath: string
    connectionId?: string
    area?: GitStagingArea
  }) => ipcRenderer.invoke('git:submoduleStatus', args),
  checkIgnored: (args: {
    worktreePath: string
    paths: string[]
    connectionId?: string
  }): Promise<string[]> => ipcRenderer.invoke('git:checkIgnored', args),
  findHugeFoldersToIgnore: (args: { worktreePath: string }): Promise<string[]> =>
    ipcRenderer.invoke('git:findHugeFoldersToIgnore', args),
  appendGitignore: (args: { worktreePath: string; folderName: string }): Promise<boolean> =>
    ipcRenderer.invoke('git:appendGitignore', args),
  history: (
    args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
  ): Promise<GitHistoryResult> => ipcRenderer.invoke('git:history', args),
  conflictOperation: (args: { worktreePath: string; connectionId?: string }) =>
    ipcRenderer.invoke('git:conflictOperation', args),
  abortMerge: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
    ipcRenderer.invoke('git:abortMerge', args),
  abortRebase: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
    ipcRenderer.invoke('git:abortRebase', args),
  diff: (args: {
    worktreePath: string
    filePath: string
    staged: boolean
    compareAgainstHead?: boolean
    connectionId?: string
  }) => ipcRenderer.invoke('git:diff', args),
  branchCompare: (args: { worktreePath: string; baseRef: string; connectionId?: string }) =>
    ipcRenderer.invoke('git:branchCompare', args),
  commitCompare: (args: { worktreePath: string; commitId: string; connectionId?: string }) =>
    ipcRenderer.invoke('git:commitCompare', args),
  upstreamStatus: (args: {
    worktreePath: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }): Promise<GitUpstreamStatus> => ipcRenderer.invoke('git:upstreamStatus', args),
  fetch: (args: {
    worktreePath: string
    worktreeId?: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }): Promise<void> => ipcRenderer.invoke('git:fetch', args),
  syncFork: (args: {
    worktreePath: string
    connectionId?: string
    expectedUpstream: GitForkSyncExpectedUpstream
  }): Promise<GitForkSyncResult> => ipcRenderer.invoke('git:syncFork', args),
  push: (args: {
    worktreePath: string
    worktreeId?: string
    publish?: boolean
    forceWithLease?: boolean
    connectionId?: string
    pushTarget?: unknown
  }): Promise<void> => ipcRenderer.invoke('git:push', args),
  pull: (args: {
    worktreePath: string
    worktreeId?: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }): Promise<void> => ipcRenderer.invoke('git:pull', args),
  fastForward: (args: {
    worktreePath: string
    worktreeId?: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }): Promise<void> => ipcRenderer.invoke('git:fastForward', args),
  rebaseFromBase: (args: {
    worktreePath: string
    baseRef: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:rebaseFromBase', args),
  branchDiff: (args: {
    worktreePath: string
    compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
    filePath: string
    oldPath?: string
    connectionId?: string
  }) => ipcRenderer.invoke('git:branchDiff', args),
  commitDiff: (args: {
    worktreePath: string
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
    connectionId?: string
  }) => ipcRenderer.invoke('git:commitDiff', args),
  commit: (args: {
    worktreePath: string
    message: string
    connectionId?: string
  }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('git:commit', args),
  generateCommitMessage: (args: {
    worktreePath: string
    worktreeId?: string
    repoId?: string
    connectionId?: string
    sourceControlAiResolvedParams?: unknown
    sourceControlAi?: unknown
    agentCmdOverrides?: Record<string, string>
  }) => ipcRenderer.invoke('git:generateCommitMessage', args),
  discoverCommitMessageModels: (args: {
    agentId: string
    worktreePath?: string
    connectionId?: string
  }) => ipcRenderer.invoke('git:discoverCommitMessageModels', args),
  cancelGenerateCommitMessage: (args: {
    worktreePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:cancelGenerateCommitMessage', args),
  generatePullRequestFields: (args: {
    worktreePath: string
    worktreeId?: string
    repoId?: string
    base: string
    title: string
    body: string
    draft: boolean
    provider?: unknown
    useTemplate?: boolean
    connectionId?: string
    sourceControlAiResolvedParams?: unknown
    sourceControlAi?: unknown
    agentCmdOverrides?: Record<string, string>
  }) => ipcRenderer.invoke('git:generatePullRequestFields', args),
  cancelGeneratePullRequestFields: (args: {
    worktreePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:cancelGeneratePullRequestFields', args),
  stage: (args: { worktreePath: string; filePath: string; connectionId?: string }): Promise<void> =>
    ipcRenderer.invoke('git:stage', args),
  bulkStage: (args: {
    worktreePath: string
    filePaths: string[]
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:bulkStage', args),
  unstage: (args: {
    worktreePath: string
    filePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:unstage', args),
  bulkUnstage: (args: {
    worktreePath: string
    filePaths: string[]
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:bulkUnstage', args),
  discard: (args: {
    worktreePath: string
    filePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:discard', args),
  bulkDiscard: (args: {
    worktreePath: string
    filePaths: string[]
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('git:bulkDiscard', args),
  remoteFileUrl: (args: {
    worktreePath: string
    relativePath: string
    line: number
    connectionId?: string
  }): Promise<string | null> => ipcRenderer.invoke('git:remoteFileUrl', args),
  remoteCommitUrl: (args: {
    worktreePath: string
    sha: string
    connectionId?: string
  }): Promise<string | null> => ipcRenderer.invoke('git:remoteCommitUrl', args)
} satisfies PreloadApi['git']
