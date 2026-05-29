import { z } from 'zod'

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

export const GitStatusParams = WorktreeSelector.extend({
  includeIgnored: z.boolean().optional()
})

export const GitCheckIgnored = WorktreeSelector.extend({
  paths: z.array(z.string().min(1, 'Missing path')).max(2000)
})

export const GitFilePath = WorktreeSelector.extend({
  filePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing file path'))
})

export const GitDiff = GitFilePath.extend({
  staged: z.boolean(),
  compareAgainstHead: z.boolean().optional()
})

export const GitBranchCompare = WorktreeSelector.extend({
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

export const GitCommitCompare = WorktreeSelector.extend({
  commitId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(FullGitObjectId)
})

export const GitHistory = WorktreeSelector.extend({
  limit: z.number().int().min(1).max(200).optional(),
  baseRef: z.string().nullable().optional()
})

export const GitBranchDiff = GitFilePath.extend({
  compare: z.object({
    baseRef: z.string().optional(),
    baseOid: FullGitObjectId.optional(),
    headOid: FullGitObjectId,
    mergeBase: FullGitObjectId
  }),
  oldPath: z.string().optional()
})

export const GitCommitDiff = GitFilePath.extend({
  commitOid: FullGitObjectId,
  parentOid: FullGitObjectId.nullable().optional(),
  oldPath: z.string().optional()
})

export const GitCommit = WorktreeSelector.extend({
  message: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing commit message'))
})

const CommitMessageModelCapability = z.object({
  id: z.string(),
  label: z.string(),
  thinkingLevels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  defaultThinkingLevel: z.string().optional()
})

const CommitMessageAiSettings = z.object({
  enabled: z.boolean(),
  agentId: z.string().nullable(),
  selectedModelByAgent: z.record(z.string(), z.string()),
  selectedModelByAgentByHost: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  discoveredModelsByAgent: z.record(z.string(), z.array(CommitMessageModelCapability)).optional(),
  discoveredModelsByAgentByHost: z
    .record(z.string(), z.record(z.string(), z.array(CommitMessageModelCapability)))
    .optional(),
  selectedThinkingByModel: z.record(z.string(), z.string()),
  customPrompt: z.string(),
  customAgentCommand: z.string()
})

const SourceControlAiSettings = CommitMessageAiSettings.omit({ customPrompt: true }).extend({
  instructionsByOperation: z.record(z.string(), z.string()).optional(),
  modelOverridesByOperation: z
    .record(
      z.string(),
      z.object({
        selectedModelByAgent: z.record(z.string(), z.string()).optional(),
        selectedModelByAgentByHost: z
          .record(z.string(), z.record(z.string(), z.string()))
          .optional(),
        selectedThinkingByModel: z.record(z.string(), z.string()).optional()
      })
    )
    .optional(),
  prCreationDefaults: z
    .object({
      draft: z.boolean().optional(),
      useTemplate: z.boolean().optional(),
      generateDetailsOnOpen: z.boolean().optional(),
      openAfterCreate: z.boolean().optional()
    })
    .optional()
})

export const GitGenerateCommitMessage = WorktreeSelector.extend({
  commitMessageAi: CommitMessageAiSettings.optional(),
  sourceControlAi: SourceControlAiSettings.optional(),
  agentCmdOverrides: z.record(z.string(), z.string()).optional(),
  enableGitHubAttribution: z.boolean().optional(),
  commitMessageDiscoveryHostKey: z.string().optional()
})

export const GitDiscoverCommitMessageModels = WorktreeSelector.extend({
  agentId: z.string().min(1, 'Missing agent id'),
  agentCmdOverrides: z.record(z.string(), z.string()).optional()
})

export const GitGeneratePullRequestFields = GitGenerateCommitMessage.extend({
  base: z.string().min(1, 'Missing base branch'),
  title: z.string(),
  body: z.string(),
  draft: z.boolean()
})

export const GitBulkPaths = WorktreeSelector.extend({
  filePaths: z.array(z.string().min(1, 'Missing file path'))
})

const GitPushTargetParam = z.object({
  remoteName: z.string(),
  branchName: z.string(),
  remoteUrl: z.string().optional(),
  remoteCreated: z.boolean().optional()
})

export const GitPush = WorktreeSelector.extend({
  publish: z.boolean().optional(),
  forceWithLease: z.boolean().optional(),
  pushTarget: GitPushTargetParam.optional()
})

export const GitTargetedRemote = WorktreeSelector.extend({
  pushTarget: GitPushTargetParam.optional()
})

export const GitRebaseFromBase = WorktreeSelector.extend({
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

export const GitRemoteFileUrl = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path')),
  line: z.number().int().min(1)
})
