import type { z } from 'zod'
import type { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import type { EphemeralVmCheckoutMode } from '../../shared/orca-yaml-hook-types'

export type RecipeWorkspaceCreateParams = z.infer<typeof WorktreeCreate>

// Fields a normal create on the environment's own Orca understands; lineage, activation and the
// caller's terminal stay on this host, which records them after the environment answers.
const FORWARDED_CREATE_FIELDS = [
  'name',
  'nameWasGenerated',
  'displayName',
  'displayNameKind',
  'baseBranch',
  'compareBaseRef',
  'branchNameOverride',
  'linkedIssue',
  'linkedPR',
  'linkedLinearIssue',
  'linkedLinearIssueWorkspaceId',
  'linkedLinearIssueOrganizationUrlKey',
  'linkedGitLabMR',
  'linkedGitLabIssue',
  'linkedBitbucketPR',
  'linkedAzureDevOpsPR',
  'linkedGiteaPR',
  'linkedWorkItem',
  'linkedItems',
  'linkedTaskSourceContext',
  'comment',
  'workspaceStatus',
  'sparseCheckout',
  'pushTarget',
  'runHooks',
  'setupDecision',
  'createdWithAgent'
] as const satisfies readonly (keyof RecipeWorkspaceCreateParams)[]

export function forwardedCreateFields(
  params: RecipeWorkspaceCreateParams
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {}
  for (const field of FORWARDED_CREATE_FIELDS) {
    if (params[field] !== undefined) {
      forwarded[field] = params[field]
    }
  }
  return forwarded
}

/** Refuses what a recipe create cannot honor before any machine is started. */
export function assertRecipeWorkspaceCreateSupported(
  params: RecipeWorkspaceCreateParams,
  checkoutMode: EphemeralVmCheckoutMode
): void {
  if (!params.name?.trim()) {
    throw new Error('A recipe workspace requires a name.')
  }
  if (params.startupAgent || params.startupCommand || params.startupDraft) {
    throw new Error(
      'Launch the agent on the recipe-created workspace with agent.launch after creation.'
    )
  }
  if (params.automationProvenanceRequest) {
    throw new Error('Recipe workspace creation does not support automation provenance requests.')
  }
  if (checkoutMode === 'provisioned-root') {
    if (params.sparseCheckout) {
      throw new Error('Provisioned-root recipes do not support sparse checkout.')
    }
    if (params.runHooks || params.setupDecision === 'run') {
      throw new Error("Provisioned-root recipes run setup in the recipe's create step.")
    }
  }
}
