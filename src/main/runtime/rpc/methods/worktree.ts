import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  TriStateLinkedIssue
} from '../schemas'

const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber
})

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const WorktreeCreate = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  name: OptionalString,
  baseBranch: OptionalString,
  linkedIssue: TriStateLinkedIssue,
  comment: OptionalString,
  runHooks: OptionalBoolean,
  setupDecision: z
    .unknown()
    .transform((v) =>
      typeof v === 'string' && (v === 'run' || v === 'skip' || v === 'inherit') ? v : undefined
    )
    .pipe(z.union([z.enum(['run', 'skip', 'inherit']), z.undefined()]))
    .optional(),
  // Why: mobile clients pass a startup command (e.g. 'claude') so the first
  // terminal pane launches the selected agent instead of an idle shell.
  startupCommand: OptionalString
})

const WorktreeSet = WorktreeSelector.extend({
  displayName: OptionalString,
  linkedIssue: TriStateLinkedIssue,
  comment: OptionalString,
  isPinned: OptionalBoolean
})

const WorktreeRemove = WorktreeSelector.extend({
  force: OptionalBoolean,
  runHooks: OptionalBoolean
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
        comment: params.comment,
        runHooks: params.runHooks === true,
        setupDecision: params.setupDecision,
        startup: params.startupCommand ? { command: params.startupCommand } : undefined
      })
  }),
  defineMethod({
    name: 'worktree.set',
    params: WorktreeSet,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.updateManagedWorktreeMeta(params.worktree, {
        displayName: params.displayName,
        linkedIssue: params.linkedIssue,
        comment: params.comment,
        isPinned: params.isPinned
      })
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
