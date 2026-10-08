import type { z } from 'zod'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorktreeCreate } from './worktree-create-schemas'

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
  provenance: CreateProvenance,
  origin: { clientKind?: 'mobile' | 'runtime' } = {}
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
    linkedItems: params.linkedItems,
    linkedTaskSourceContext: params.linkedTaskSourceContext,
    comment: params.comment,
    displayName: params.displayName,
    displayNameKind: params.displayNameKind,
    telemetrySource: params.telemetrySource,
    workspaceStatus: params.workspaceStatus,
    manualOrder: params.manualOrder,
    sparseCheckout: params.sparseCheckout,
    pushTarget: params.pushTarget,
    runHooks: params.runHooks === true,
    activate: params.activate === true,
    // Mobile needs host-renderer provisioning; CLI activation also belongs to the host, not its observers.
    navigation: resolveRuntimeNavigationTarget({
      ...(params.navigation
        ? {
            // Older CLIs hardcode 'all' for --activate/--run-hooks; neither flag requests a client broadcast.
            navigation:
              params.cliProvenanceRequest !== undefined && params.navigation === 'all'
                ? ('host' as const)
                : params.navigation
          }
        : {}),
      ...(origin.clientKind === 'runtime' && params.cliProvenanceRequest === undefined
        ? { clientKind: origin.clientKind }
        : {}),
      defaultTarget: 'host'
    }),
    setupDecision: params.setupDecision,
    createdWithAgent: params.createdWithAgent ?? params.startupAgent,
    ...provenance,
    // Why: a person initiated this create (the phone, CLI text and agent.launch don't surface the
    // fallback yet); an automation run has no one watching, so it keeps the network error.
    ...(provenance.automationProvenance ? {} : { allowLocalBaseFallback: true }),
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
    ...(params.startupClaudeAccount !== undefined
      ? { startupClaudeAccount: params.startupClaudeAccount }
      : {}),
    ...(params.launchSource ? { startupLaunchSource: params.launchSource } : {}),
    startupDraft: params.startupDraft,
    lineage: {
      parentWorkspace: params.parentWorkspace,
      ...(params.parentWorkspaceOrigin ? { parentWorkspaceOrigin: 'manual' as const } : {}),
      envParentWorkspace: params.envParentWorkspace,
      parentWorktree: params.parentWorktree,
      ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
      noParent: params.noParent === true,
      callerTerminalHandle: params.callerTerminalHandle,
      orchestrationContext: params.orchestrationContext
    }
  }
}
