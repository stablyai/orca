import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import { createWorktreeWithStartupAgent } from '../../../agent-launch/startup-agent-worktree-create'
import { defineMethod } from '../core'
import { buildManagedWorktreeCreateArgs, worktreeCreateRepoSelector } from './worktree-create-args'
import { resolvePairedCallerHostId } from './paired-caller-host-id'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import {
  WorktreeCreate,
  WorktreePrefetchCreateBase
} from '../../../../shared/rpc-contract/worktree-create-params'
import {
  WorktreeActivate,
  WorktreeForceDeleteBranch,
  WorktreeRemove,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams
} from '../../../../shared/rpc-contract/worktree-params'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'
import { WORKTREE_PROVISIONED_ROOT_METHOD } from './worktree-provisioned-root-method'
import { waitsForWorktreeRemoval } from '../worktree-removal-marker-projection'
import { queueWorkspaceDelete } from '../../workspaces/workspace-lifecycle-commands'
import { WORKTREE_SLEEP_METHOD } from './worktree-sleep-method'
import { WORKTREE_SET_METHOD } from './worktree-set-method'

export const WORKTREE_METHODS = [
  ...WORKTREE_CATALOG_METHODS,
  defineMethod({
    name: 'worktree.teardownMissingTerminals',
    permission: 'workspace',
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
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage()
    })
  }),
  defineMethod({
    name: 'worktree.show',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree)
    })
  }),
  WORKTREE_SLEEP_METHOD,
  defineMethod({
    name: 'worktree.activate',
    permission: 'workspace',
    params: WorktreeActivate,
    handler: async (params, { runtime, clientKind }) =>
      // Only mobile activation wakes host-renderer slept agents; preserve web/desktop behavior.
      runtime.activateManagedWorktree(params.worktree, {
        notifyClients: params.notifyClients !== false,
        clientKind,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind,
          defaultTarget: 'host'
        })
      })
  }),
  defineMethod({
    name: 'worktree.create',
    permission: 'workspace',
    params: WorktreeCreate,
    handler: async (params, context) =>
      // Mobile retries after migration share clientMutationId; return the same pending/created worktree. Desktop/CLI without keys run plainly.
      context.runtime.dedupeWorktreeCreate(params, params.clientMutationId, async () => {
        const { runtime } = context
        const repo = await runtime.showRepo(worktreeCreateRepoSelector(params))
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest
        })
        // Reserve provenance before create for recovery, but release failed reservations so retry is safe.
        try {
          const result = await createWorktreeWithStartupAgent(
            runtime,
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
              context
            )
          )
          finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          // Create notification already bumped generation; stamp the catalog containing the new worktree.
          const stamped = { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
          // Agent callers need a stable target without duplicate terminal-list layout entries.
          return params.startupAgent && result.startupTerminal?.handle
            ? { ...stamped, agentTerminalHandle: result.startupTerminal.handle }
            : stamped
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          throw error
        }
      })
  }),
  WORKTREE_PROVISIONED_ROOT_METHOD,
  defineMethod({
    name: 'worktree.prefetchCreateBase',
    permission: 'workspace',
    params: WorktreePrefetchCreateBase,
    handler: async (params, { runtime }) => {
      await runtime.prefetchManagedWorktreeCreateBase({
        repoSelector: params.repo,
        baseBranch: params.baseBranch
      })
      return null
    }
  }),
  WORKTREE_SET_METHOD,
  defineMethod({
    name: 'worktree.persistSortOrder',
    permission: 'workspace',
    params: WorktreeSortOrder,
    handler: async (params, { runtime }) =>
      runtime.persistManagedWorktreeSortOrder(params.orderedIds, params.hostIds)
  }),
  defineMethod({
    name: 'worktree.resolvePrBase',
    permission: 'workspace',
    params: WorktreeResolvePrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedPrBase({
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        baseRefName: params.baseRefName,
        isCrossRepository: params.isCrossRepository,
        wakeWslDistro: params.wakeWslDistro
      })
  }),
  defineMethod({
    name: 'worktree.resolveMrBase',
    permission: 'workspace',
    params: WorktreeResolveMrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedMrBase({
        repoSelector: params.repo,
        mrIid: params.mrIid,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        isCrossRepository: params.isCrossRepository,
        wakeWslDistro: params.wakeWslDistro
      })
  }),
  defineMethod({
    name: 'worktree.rm',
    permission: 'workspace',
    params: WorktreeRemove,
    handler: async (params, context) => {
      const { runtime } = context
      // Translate a paired client's runtime-local host spelling before host-qualified reads.
      let resolvedHostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      // Older mobile omits hostId; resolve ambiguity before pinning removal and refuse ids shared by two hosts.
      if (!resolvedHostId) {
        try {
          resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
          if (!resolvedHostId) {
            throw new Error('worktree.rm could not resolve the workspace host')
          }
        } catch (error) {
          // Git may omit a stale path: selector_not_found must reach removeManagedWorktree; propagate other resolution failures.
          if (!(error instanceof Error) || error.message !== 'selector_not_found') {
            throw error
          }
        }
      }
      // Parse id: selectors for repo stamping; resolving again scans and rejects ids shared by hosts. Leave other selectors unstamped.
      const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
      const repoId = explicitWorktreeId ? splitWorktreeId(explicitWorktreeId)?.repoId : undefined
      const result = await queueWorkspaceDelete(
        runtime,
        params.worktree,
        resolvedHostId,
        params,
        (removal) =>
          runtime.removeManagedWorktree(params.worktree, {
            ...removal,
            waitForBackgroundRemoval: waitsForWorktreeRemoval(context, params)
          })
      )
      return {
        removed: result.removing !== true,
        ...result,
        ...(repoId ? { catalogVersion: getLocalWorktreeCatalogVersion(repoId) } : {})
      }
    }
  }),
  defineMethod({
    name: 'worktree.forceDeleteBranch',
    permission: 'workspace',
    params: WorktreeForceDeleteBranch,
    handler: async (params, { runtime }) => {
      const hostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      return hostId
        ? runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead,
            hostId
          )
        : runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead
          )
    }
  })
]
