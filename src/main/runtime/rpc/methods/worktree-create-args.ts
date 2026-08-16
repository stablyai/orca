import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorktreeCreate } from './worktree-schemas'

type WorktreeCreateParams = z.infer<typeof WorktreeCreate>
type ManagedWorktreeCreateArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]
type CreateProvenance = Pick<
  ManagedWorktreeCreateArgs,
  'automationProvenance' | 'cliProvenance' | 'creatorProvenance'
>

/** Wire params → runtime create args. Kept out of the method table so the mapping can grow with
 *  the schema without the table becoming unreadable. */
export function buildManagedWorktreeCreateArgs(
  params: WorktreeCreateParams,
  provenance: CreateProvenance
): ManagedWorktreeCreateArgs {
  return {
    repoSelector: params.repo,
    name: params.name ?? '',
    // Absent means the user typed the name, which must never be retired.
    ...(params.nameWasGenerated === true ? { nameWasGenerated: true } : {}),
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
    ...provenance,
    startup: params.startupCommand
      ? {
          command: params.startupCommand,
          ...(params.startupEnv ? { env: params.startupEnv } : {}),
          ...(params.startupLaunchConfig ? { launchConfig: params.startupLaunchConfig } : {}),
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
      envParentWorkspace: params.envParentWorkspace,
      parentWorktree: params.parentWorktree,
      ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
      noParent: params.noParent === true,
      callerTerminalHandle: params.callerTerminalHandle,
      orchestrationContext: params.orchestrationContext
    }
  }
}
