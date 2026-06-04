import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { workspaceSourceSchema } from '../../../../shared/telemetry-events'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from '../schemas'

const OptionalTuiAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== undefined && !isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
  .optional()

export const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

export const WorktreeDetectedListParams = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector'))
})

export const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber
})

export const WorktreeSortOrder = z.object({
  orderedIds: z.array(z.string())
})

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

export const WorktreeCreate = z
  .object({
    repo: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing repo selector')),
    name: OptionalString,
    baseBranch: OptionalString,
    branchNameOverride: OptionalString,
    linkedIssue: TriStateLinkedIssue,
    linkedPR: TriStateLinkedIssue,
    linkedLinearIssue: z.string().optional(),
    linkedGitLabMR: TriStateLinkedIssue,
    linkedGitLabIssue: TriStateLinkedIssue,
    comment: OptionalString,
    displayName: OptionalString,
    telemetrySource: z
      .unknown()
      .transform((value) => {
        const parsed = workspaceSourceSchema.safeParse(value)
        return parsed.success ? parsed.data : undefined
      })
      .optional(),
    workspaceStatus: OptionalString,
    manualOrder: OptionalFiniteNumber,
    sparseCheckout: z
      .object({
        directories: z.array(z.string()),
        presetId: OptionalString
      })
      .optional(),
    pushTarget: z
      .object({
        remoteName: z.string(),
        branchName: z.string(),
        remoteUrl: OptionalString
      })
      .optional(),
    runHooks: OptionalBoolean,
    activate: OptionalBoolean,
    parentWorktree: OptionalString,
    cwdParentWorktree: OptionalString,
    noParent: OptionalBoolean,
    callerTerminalHandle: OptionalString,
    orchestrationContext: z
      .object({
        parentWorktreeId: OptionalString,
        orchestrationRunId: OptionalString,
        taskId: OptionalString,
        coordinatorHandle: OptionalString
      })
      .optional(),
    setupDecision: z
      .unknown()
      .transform((v) =>
        typeof v === 'string' && (v === 'run' || v === 'skip' || v === 'inherit') ? v : undefined
      )
      .pipe(z.union([z.enum(['run', 'skip', 'inherit']), z.undefined()]))
      .optional(),
    // Why: mobile clients pass a startup command (e.g. 'claude') so the first
    // terminal pane launches the selected agent instead of an idle shell.
    startupCommand: OptionalString,
    startupEnv: z.record(z.string(), z.string()).optional(),
    // Why: CLI clients should not hardcode agent launch quoting because SSH
    // workspaces execute in a different shell than the client process.
    startupAgent: OptionalTuiAgent,
    startupPrompt: OptionalString,
    // Why: task-driven mobile creates need desktop parity: the host chooses
    // the same default/detected agent and drafts the linked issue/PR URL into it.
    startupDraft: OptionalString,
    createdWithAgent: z
      .unknown()
      .transform((value) => (isTuiAgent(value) ? value : undefined))
      .optional()
  })
  .superRefine((params, ctx) => {
    if (params.parentWorktree && params.noParent === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either --parent-worktree or --no-parent, not both.'
      })
    }
    if (params.startupPrompt !== undefined && params.startupAgent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startupPrompt requires startupAgent'
      })
    }
  })

export const WorktreePrefetchCreateBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  baseBranch: OptionalString
})

export const WorktreeSet = WorktreeSelector.extend({
  displayName: OptionalString,
  // Why: empty comments are meaningful metadata updates, so use the plain
  // string parser instead of OptionalString's empty-as-undefined behavior.
  comment: OptionalPlainString,
  linkedIssue: TriStateLinkedIssue,
  linkedPR: TriStateLinkedIssue,
  linkedLinearIssue: z.union([z.string(), z.null()]).optional(),
  linkedGitLabMR: TriStateLinkedIssue,
  linkedGitLabIssue: TriStateLinkedIssue,
  isArchived: OptionalBoolean,
  isUnread: OptionalBoolean,
  isPinned: OptionalBoolean,
  sortOrder: OptionalFiniteNumber,
  manualOrder: OptionalFiniteNumber,
  lastActivityAt: OptionalFiniteNumber,
  createdAt: OptionalFiniteNumber,
  sparseDirectories: z.array(z.string()).optional(),
  sparseBaseRef: OptionalString,
  sparsePresetId: OptionalString,
  baseRef: OptionalString,
  workspaceStatus: OptionalString,
  pushTarget: z
    .object({
      remoteName: z.string(),
      branchName: z.string(),
      remoteUrl: OptionalString
    })
    .optional(),
  diffComments: z.array(z.unknown()).optional(),
  parentWorktree: OptionalString,
  noParent: OptionalBoolean
}).superRefine((params, ctx) => {
  if (params.parentWorktree && params.noParent === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose either --parent-worktree or --no-parent, not both.'
    })
  }
})

export const WorktreeRemove = WorktreeSelector.extend({
  force: OptionalBoolean,
  runHooks: OptionalBoolean
})

export const WorktreeForceDeleteBranch = WorktreeSelector.extend({
  branchName: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing branch name')),
  expectedHead: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing expected branch head'))
})

export const WorktreeResolvePrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  prNumber: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing PR number')),
  headRefName: OptionalString,
  isCrossRepository: OptionalBoolean
})

export const WorktreeResolveMrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  mrIid: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing MR number')),
  sourceBranch: OptionalString,
  isCrossRepository: OptionalBoolean
})
