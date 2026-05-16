import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from '../schemas'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber
})

const WorktreeSortOrder = z.object({
  orderedIds: z.array(z.string())
})

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const WorktreeCreate = z
  .object({
    repo: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing repo selector')),
    name: OptionalString,
    baseBranch: OptionalString,
    linkedIssue: TriStateLinkedIssue,
    linkedPR: TriStateLinkedIssue,
    linkedLinearIssue: z.string().optional(),
    comment: OptionalString,
    displayName: OptionalString,
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
  })

const WorktreeSet = WorktreeSelector.extend({
  displayName: OptionalString,
  // Why: empty comments are meaningful metadata updates, so use the plain
  // string parser instead of OptionalString's empty-as-undefined behavior.
  comment: OptionalPlainString,
  linkedIssue: TriStateLinkedIssue,
  linkedPR: TriStateLinkedIssue,
  linkedLinearIssue: z.union([z.string(), z.null()]).optional(),
  isArchived: OptionalBoolean,
  isUnread: OptionalBoolean,
  isPinned: OptionalBoolean,
  sortOrder: OptionalFiniteNumber,
  lastActivityAt: OptionalFiniteNumber,
  createdAt: OptionalFiniteNumber,
  sparseDirectories: z.array(z.string()).optional(),
  sparseBaseRef: OptionalString,
  sparsePresetId: OptionalString,
  baseRef: OptionalString,
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

const WorktreeRemove = WorktreeSelector.extend({
  force: OptionalBoolean,
  runHooks: OptionalBoolean
})

const WorktreeResolvePrBase = z.object({
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

export const WORKTREE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'worktree.ps',
    params: WorktreePsParams,
    handler: async (params, { runtime }) => runtime.getWorktreePs(params.limit)
  }),
  defineMethod({
    name: 'worktree.list',
    params: WorktreeListParams,
    handler: async (params, { runtime }) => runtime.listManagedWorktrees(params.repo, params.limit)
  }),
  defineMethod({
    name: 'worktree.lineageList',
    params: null,
    handler: async (_params, { runtime }) => ({ lineage: await runtime.listWorktreeLineage() })
  }),
  defineMethod({
    name: 'worktree.show',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree)
    })
  }),
  defineMethod({
    name: 'worktree.sleep',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.sleepManagedWorktree(params.worktree)
  }),
  defineMethod({
    name: 'worktree.activate',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.activateManagedWorktree(params.worktree)
  }),
  defineMethod({
    name: 'worktree.create',
    params: WorktreeCreate,
    handler: async (params, { runtime }) =>
      runtime.createManagedWorktree({
        repoSelector: params.repo,
        name: params.name ?? '',
        baseBranch: params.baseBranch,
        linkedIssue: params.linkedIssue,
        linkedPR: params.linkedPR,
        linkedLinearIssue: params.linkedLinearIssue,
        comment: params.comment,
        displayName: params.displayName,
        sparseCheckout: params.sparseCheckout,
        pushTarget: params.pushTarget,
        runHooks: params.runHooks === true,
        activate: params.activate === true,
        setupDecision: params.setupDecision,
        createdWithAgent: params.createdWithAgent,
        startup: params.startupCommand ? { command: params.startupCommand } : undefined,
        lineage: {
          parentWorktree: params.parentWorktree,
          ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
          noParent: params.noParent === true,
          callerTerminalHandle: params.callerTerminalHandle,
          orchestrationContext: params.orchestrationContext
        }
      })
  }),
  defineMethod({
    name: 'worktree.set',
    params: WorktreeSet,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.updateManagedWorktreeMeta(params.worktree, {
        displayName: params.displayName,
        linkedIssue: params.linkedIssue,
        linkedPR: params.linkedPR,
        linkedLinearIssue: params.linkedLinearIssue,
        comment: params.comment,
        isArchived: params.isArchived,
        isUnread: params.isUnread,
        isPinned: params.isPinned,
        sortOrder: params.sortOrder,
        lastActivityAt: params.lastActivityAt,
        createdAt: params.createdAt,
        sparseDirectories: params.sparseDirectories,
        sparseBaseRef: params.sparseBaseRef,
        sparsePresetId: params.sparsePresetId,
        baseRef: params.baseRef,
        pushTarget: params.pushTarget,
        diffComments: params.diffComments,
        lineage:
          params.parentWorktree || params.noParent === true
            ? {
                parentWorktree: params.parentWorktree,
                noParent: params.noParent === true
              }
            : undefined
      } as Parameters<typeof runtime.updateManagedWorktreeMeta>[1])
    })
  }),
  defineMethod({
    name: 'worktree.persistSortOrder',
    params: WorktreeSortOrder,
    handler: async (params, { runtime }) =>
      runtime.persistManagedWorktreeSortOrder(params.orderedIds)
  }),
  defineMethod({
    name: 'worktree.resolvePrBase',
    params: WorktreeResolvePrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedPrBase({
        repoId: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.rm',
    params: WorktreeRemove,
    handler: async (params, { runtime }) => {
      const result = await runtime.removeManagedWorktree(
        params.worktree,
        params.force === true,
        params.runHooks === true
      )
      return { removed: true, ...result }
    }
  })
]
