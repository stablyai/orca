import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const GitFilePath = WorktreeSelector.extend({
  filePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing file path'))
})

const GitDiff = GitFilePath.extend({
  staged: z.boolean(),
  compareAgainstHead: z.boolean().optional()
})

const GitBranchCompare = WorktreeSelector.extend({
  baseRef: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(
      z
        .string()
        .min(1, 'Missing base ref')
        .refine((value) => !value.startsWith('-'), 'Base ref must not start with -')
    )
})

const FullGitObjectId = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, 'Expected a full git object id')

const GitBranchDiff = GitFilePath.extend({
  compare: z.object({
    baseRef: z.string().optional(),
    baseOid: FullGitObjectId.optional(),
    headOid: FullGitObjectId,
    mergeBase: FullGitObjectId
  }),
  oldPath: z.string().optional()
})

const GitCommit = WorktreeSelector.extend({
  message: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing commit message'))
})

const GitBulkPaths = WorktreeSelector.extend({
  filePaths: z.array(z.string())
})

const GitPush = WorktreeSelector.extend({
  publish: z.boolean().optional(),
  pushTarget: z.unknown().optional()
})

const GitRemoteFileUrl = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path')),
  line: z.number().int().min(1)
})

export const GIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'git.status',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitStatus(params.worktree)
  }),
  defineMethod({
    name: 'git.conflictOperation',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitConflictOperation(params.worktree)
  }),
  defineMethod({
    name: 'git.diff',
    params: GitDiff,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitDiff(
        params.worktree,
        params.filePath,
        params.staged,
        params.compareAgainstHead
      )
  }),
  defineMethod({
    name: 'git.branchCompare',
    params: GitBranchCompare,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchCompare(params.worktree, params.baseRef)
  }),
  defineMethod({
    name: 'git.upstreamStatus',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.getRuntimeGitUpstreamStatus(params.worktree)
  }),
  defineMethod({
    name: 'git.fetch',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.fetchRuntimeGit(params.worktree)
  }),
  defineMethod({
    name: 'git.pull',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.pullRuntimeGit(params.worktree)
  }),
  defineMethod({
    name: 'git.push',
    params: GitPush,
    handler: async (params, { runtime }) =>
      runtime.pushRuntimeGit(params.worktree, params.publish, params.pushTarget as never)
  }),
  defineMethod({
    name: 'git.branchDiff',
    params: GitBranchDiff,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitBranchDiff(
        params.worktree,
        params.compare,
        params.filePath,
        params.oldPath
      )
  }),
  defineMethod({
    name: 'git.commit',
    params: GitCommit,
    handler: async (params, { runtime }) =>
      runtime.commitRuntimeGit(params.worktree, params.message)
  }),
  defineMethod({
    name: 'git.stage',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.stageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkStage',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkStageRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.unstage',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.unstageRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.bulkUnstage',
    params: GitBulkPaths,
    handler: async (params, { runtime }) =>
      runtime.bulkUnstageRuntimeGitPaths(params.worktree, params.filePaths)
  }),
  defineMethod({
    name: 'git.discard',
    params: GitFilePath,
    handler: async (params, { runtime }) =>
      runtime.discardRuntimeGitPath(params.worktree, params.filePath)
  }),
  defineMethod({
    name: 'git.remoteFileUrl',
    params: GitRemoteFileUrl,
    handler: async (params, { runtime }) =>
      runtime.getRuntimeGitRemoteFileUrl(params.worktree, params.relativePath, params.line)
  })
]
