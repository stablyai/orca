import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import { defineMethod, type RpcMethod } from '../core'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { WorktreeCreate, WorktreePrefetchCreateBase } from './worktree-create-schemas'
import {
  WorktreeActivate,
  WorktreeForceDeleteBranch,
  WorktreeRemove,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSet,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams
} from './worktree-schemas'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'

export const WORKTREE_METHODS: RpcMethod[] = [
  ...WORKTREE_CATALOG_METHODS,
  defineMethod({
    name: 'worktree.teardownMissingTerminals',
    params: WorktreeTeardownMissingTerminalsParams,
    handler: async (params, { runtime }) =>
      runtime.teardownMissingManagedWorktreeTerminals(
        params.repo,
        params.worktreeIds,
        params.connectionId
      )
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
    params: WorktreeActivate,
    handler: async (params, { runtime, clientKind }) =>
      // Why: clientKind ('mobile'|'runtime') scopes the host-renderer slept-agent
      // wake to phones so web/desktop activation behavior is unchanged.
      runtime.activateManagedWorktree(params.worktree, {
        notifyClients: params.notifyClients !== false,
        clientKind,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind
        })
      })
  }),
  defineMethod({
    name: 'worktree.create',
    params: WorktreeCreate,
    handler: async (params, context) =>
      // Why: a mobile create interrupted by a connection migration is retried with
      // the same clientMutationId; dedupe so the host returns the in-flight/created
      // worktree instead of spawning a duplicate. No key (desktop/CLI) runs plainly.
      context.runtime.dedupeWorktreeCreate(params.repo, params.clientMutationId, async () => {
        const { runtime } = context
        const repo = await runtime.showRepo(params.repo)
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest
        })
        // Why: provenance tokens are reserved before creation so retries can recover,
        // but failed create attempts must release the reservation for a safe retry.
        try {
          const result = await runtime.createManagedWorktree(
            buildManagedWorktreeCreateArgs(
              params,
              {
                automationProvenance,
                cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
                  startupAgent: params.startupAgent ?? params.createdWithAgent,
                  createdAt: Date.now()
                }),
                creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
              },
              context.clientKind ? { clientKind: context.clientKind } : {}
            )
          )
          finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          // Why: agent callers need a stable dispatch target without traversing
          // terminal-list layout duplicates after creating the worktree.
          return params.startupAgent && result.startupTerminal?.handle
            ? { ...result, agentTerminalHandle: result.startupTerminal.handle }
            : result
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          throw error
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
        linkedWorkItem: params.linkedWorkItem,
        linkedTaskSourceContext: params.linkedTaskSourceContext,
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
        baseRefName: params.baseRefName,
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
        targetBranch: params.targetBranch,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.rm',
    params: WorktreeRemove,
    handler: async (params, { runtime }) => {
      // Older mobile clients omit hostId, so resolve through the ambiguity gate
      // before pinning removal. An ambiguous selector still fails closed: two
      // hosts own the id and an unqualified client cannot say which it meant.
      let resolvedHostId = params.hostId
      if (!resolvedHostId) {
        try {
          resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
          if (!resolvedHostId) {
            throw new Error('worktree.rm could not resolve the workspace host')
          }
        } catch (error) {
          // 'selector_not_found' is not a failure to attribute — Git simply no
          // longer lists the path. A delete legitimately arrives in that state and
          // `removeManagedWorktree` handles it, so a stale workspace stays
          // deletable by a client that sends no host. Anything else propagates.
          if (!(error instanceof Error) || error.message !== 'selector_not_found') {
            throw error
          }
        }
      }
      const removalArgs = [
        params.worktree,
        params.force === true,
        params.runHooks === true,
        params.allowUnverifiedPtyStop === true
      ] as const
      const result = await runtime.removeManagedWorktree(...removalArgs, resolvedHostId)
      return { removed: true, ...result }
    }
  }),
  defineMethod({
    name: 'worktree.forceDeleteBranch',
    params: WorktreeForceDeleteBranch,
    handler: async (params, { runtime }) =>
      params.hostId
        ? runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead,
            params.hostId
          )
        : runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead
          )
  })
]
