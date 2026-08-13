import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import { defineMethod, type RpcMethod } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { WorktreeCreate } from './worktree-schemas'

export const WORKTREE_CREATE_METHOD: RpcMethod = defineMethod({
  name: 'worktree.create',
  params: WorktreeCreate,
  handler: async (params, context) =>
    context.runtime.dedupeWorktreeCreate(
      params.repoAuthority
        ? JSON.stringify([
            params.repo,
            params.repoAuthority.path,
            params.repoAuthority.connectionId
          ])
        : params.repo,
      params.clientMutationId,
      async () => {
        const { runtime } = context
        const repo = await runtime.showRepo(params.repo, params.repoAuthority)
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest
        })
        try {
          const result = await runtime.createManagedWorktree({
            repoSelector: params.repo,
            ...(params.repoAuthority ? { repoAuthority: params.repoAuthority } : {}),
            name: params.name ?? '',
            baseBranch: params.baseBranch,
            compareBaseRef: params.compareBaseRef,
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
            linkedWorkItem: params.linkedWorkItem,
            linkedTaskSourceContext: params.linkedTaskSourceContext,
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
            automationProvenance,
            cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
              startupAgent: params.startupAgent ?? params.createdWithAgent,
              createdAt: Date.now()
            }),
            creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context),
            startup: params.startupCommand
              ? {
                  command: params.startupCommand,
                  ...(params.startupEnv ? { env: params.startupEnv } : {}),
                  ...(params.startupLaunchConfig
                    ? { launchConfig: params.startupLaunchConfig }
                    : {}),
                  ...(params.startupCommandDelivery
                    ? { startupCommandDelivery: params.startupCommandDelivery }
                    : {})
                }
              : undefined,
            ...(params.startupAgent ? { startupAgent: params.startupAgent } : {}),
            ...(params.startupPrompt !== undefined ? { startupPrompt: params.startupPrompt } : {}),
            startupDraft: params.startupDraft,
            lineage: {
              parentWorkspace: params.parentWorkspace,
              parentWorkspaceCaptureSource: params.parentWorkspaceCaptureSource,
              envParentWorkspace: params.envParentWorkspace,
              parentWorktree: params.parentWorktree,
              ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
              noParent: params.noParent === true,
              callerTerminalHandle: params.callerTerminalHandle,
              orchestrationContext: params.orchestrationContext
            }
          })
          finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          return params.startupAgent && result.startupTerminal?.handle
            ? { ...result, agentTerminalHandle: result.startupTerminal.handle }
            : result
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          throw error
        }
      }
    )
})
