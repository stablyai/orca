import { defineMethod, type RpcMethod } from '../core'
import {
  WorktreeCreate,
  WorktreeDetectedListParams,
  WorktreeForceDeleteBranch,
  WorktreeListParams,
  WorktreePrefetchCreateBase,
  WorktreePsParams,
  WorktreeRemove,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSet,
  WorktreeSortOrder
} from './worktree-schemas'

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
    name: 'worktree.detectedList',
    params: WorktreeDetectedListParams,
    handler: async (params, { runtime }) => runtime.listDetectedManagedWorktrees(params.repo)
  }),
  defineMethod({
    name: 'worktree.lineageList',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage()
    })
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
        branchNameOverride: params.branchNameOverride,
        linkedIssue: params.linkedIssue,
        linkedPR: params.linkedPR,
        linkedLinearIssue: params.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabMR: params.linkedGitLabMR,
        linkedGitLabIssue: params.linkedGitLabIssue,
        linkedBitbucketPR: params.linkedBitbucketPR,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
        linkedGiteaPR: params.linkedGiteaPR,
        comment: params.comment,
        displayName: params.displayName,
        telemetrySource: params.telemetrySource,
        workspaceStatus: params.workspaceStatus,
        manualOrder: params.manualOrder,
        sparseCheckout: params.sparseCheckout,
        pushTarget: params.pushTarget,
        runHooks: params.runHooks === true,
        activate: params.activate === true,
        setupDecision: params.setupDecision,
        createdWithAgent: params.createdWithAgent ?? params.startupAgent,
        startup: params.startupCommand
          ? {
              command: params.startupCommand,
              ...(params.startupEnv ? { env: params.startupEnv } : {})
            }
          : undefined,
        ...(params.startupAgent ? { startupAgent: params.startupAgent } : {}),
        ...(params.startupPrompt !== undefined ? { startupPrompt: params.startupPrompt } : {}),
        startupDraft: params.startupDraft,
        lineage: {
          parentWorkspace: params.parentWorkspace,
          envParentWorkspace: params.envParentWorkspace,
          parentWorktree: params.parentWorktree,
          ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
          noParent: params.noParent === true,
          callerTerminalHandle: params.callerTerminalHandle,
          orchestrationContext: params.orchestrationContext
        }
      })
  }),
  defineMethod({
    name: 'worktree.prefetchCreateBase',
    params: WorktreePrefetchCreateBase,
    handler: async (params, { runtime }) => {
      await runtime.prefetchManagedWorktreeCreateBase({
        repoSelector: params.repo,
        baseBranch: params.baseBranch
      })
      return null
    }
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
        linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabMR: params.linkedGitLabMR,
        linkedGitLabIssue: params.linkedGitLabIssue,
        linkedBitbucketPR: params.linkedBitbucketPR,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
        linkedGiteaPR: params.linkedGiteaPR,
        comment: params.comment,
        isArchived: params.isArchived,
        isUnread: params.isUnread,
        isPinned: params.isPinned,
        sortOrder: params.sortOrder,
        manualOrder: params.manualOrder,
        lastActivityAt: params.lastActivityAt,
        createdAt: params.createdAt,
        sparseDirectories: params.sparseDirectories,
        sparseBaseRef: params.sparseBaseRef,
        sparsePresetId: params.sparsePresetId,
        baseRef: params.baseRef,
        workspaceStatus: params.workspaceStatus,
        pushTarget: params.pushTarget,
        diffComments: params.diffComments,
        mobileDiffReview: params.mobileDiffReview,
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
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.resolveMrBase',
    params: WorktreeResolveMrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedMrBase({
        repoSelector: params.repo,
        mrIid: params.mrIid,
        sourceBranch: params.sourceBranch,
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
  }),
  defineMethod({
    name: 'worktree.forceDeleteBranch',
    params: WorktreeForceDeleteBranch,
    handler: async (params, { runtime }) =>
      runtime.forceDeletePreservedBranch(params.worktree, params.branchName, params.expectedHead)
  })
]
