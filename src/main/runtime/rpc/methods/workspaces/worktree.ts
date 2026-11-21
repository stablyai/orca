import { readCallerStoreInstallationId } from '../../../hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../../../persistence/loading-store/user-data-path'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance,
  resolveClientAutomationWorkspaceProvenance
} from '../../../../automations/ownership/workspace-provenance'
import { getLocalWorktreeCatalogVersion } from '../../../../workspaces/catalog/local-worktree-scan-generation'
import { buildCliWorkspaceProvenance } from '../../../../../shared/worktree/creation/cli-workspace-provenance'
import { createWorktreeWithStartupAgent } from '../../../../agent-launch/startup-agent-worktree-create'
import { defineMethod } from '../../core'
import { buildManagedWorktreeCreateArgs, worktreeCreateRepoSelector } from './worktree-create-args'
import { resolvePairedCallerHostId } from '../pairing/paired-caller-host-id'
import { resolveRuntimeNavigationTarget } from '../../../../../shared/remote-runtime/session-graph/runtime-navigation'
import { resolveRpcWorkspaceCreatorProvenance } from '../../callers/workspace-creator-context'
import {
  WorktreeCreate,
  WorktreePrefetchCreateBase
} from '../../../../../shared/rpc-contract/workspaces/worktree-create-params'
import {
  WorktreeActivate,
  WorktreeForceDeleteBranch,
  WorktreePreviewNestedRemoval,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeRunApprovedSetup,
  WorktreeShow,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams,
  WorktreeResolveCallerParent
} from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'
import { WORKTREE_PROVISIONED_ROOT_METHOD } from './worktree-provisioned-root-method'
import { WORKTREE_SLEEP_METHOD } from './worktree-sleep-method'
import {
  WORKTREE_ARCHIVE_HOOK_APPROVAL_METHOD,
  WORKTREE_REMOVE_METHOD
} from './worktree-remove-method'
import { WORKSPACE_CLEANUP_SCAN_METHOD } from './workspace-cleanup-scan-method'
import { WORKTREE_SET_METHOD } from './worktree-set-method'
import { runApprovedCreatedWorktreeSetup } from '../../../workspaces/creation/created-worktree-approved-setup'

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
    name: 'worktree.runApprovedSetup',
    permission: 'workspace',
    params: WorktreeRunApprovedSetup,
    handler: async (params, { runtime }) =>
      runApprovedCreatedWorktreeSetup(runtime, params.worktree, params.approvedSetupHash, {
        wslUserAct: true
      })
  }),
  defineMethod({
    name: 'worktree.lineageList',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage(),
      // Older desktops ignore it, so these children stay standalone there.
      crossStoreLineage: runtime.listCrossStoreLineage(),
      // Paired clients name this store by it when linking a child on another machine.
      installationId: await runtime.readStoreInstallationId()
    })
  }),
  defineMethod({
    name: 'worktree.resolveCallerParent',
    permission: 'workspace',
    params: WorktreeResolveCallerParent,
    handler: async (params, { runtime }) =>
      await runtime.resolveCallerParentForAnotherStore(
        params,
        await readCallerStoreInstallationId(runtime.getRuntimeId(), getCanonicalUserDataPath())
      )
  }),
  defineMethod({
    name: 'worktree.show',
    permission: 'workspace',
    params: WorktreeShow,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree, undefined, {
        matchFolders: params.matchFolderWorkspaces === true
      })
    })
  }),
  WORKTREE_SLEEP_METHOD,
  WORKSPACE_CLEANUP_SCAN_METHOD,
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
        const automationProvenance =
          resolveAutomationWorkspaceProvenance({
            authority: runtime,
            repoSelector: params.repo,
            repo,
            request: params.automationProvenanceRequest,
            ignoreUnknownAutomation: true
          }) ??
          resolveClientAutomationWorkspaceProvenance({
            authority: runtime,
            provenance: params.clientAutomationProvenance
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
  WORKTREE_REMOVE_METHOD,
  WORKTREE_ARCHIVE_HOOK_APPROVAL_METHOD,
  defineMethod({
    name: 'worktree.previewNestedRemoval',
    permission: 'workspace',
    params: WorktreePreviewNestedRemoval,
    handler: async (params, { runtime }) =>
      runtime.previewNestedManagedWorktreeRemoval(
        params.worktree,
        resolvePairedCallerHostId(() => runtime.listRepos(), params.worktree, params.hostId)
      )
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
