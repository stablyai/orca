import { z } from 'zod'
import type { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import type { EphemeralVmCheckoutMode } from '../../shared/orca-yaml-hook-types'

// Kept apart from the orchestration so runtime types (and the mobile host-declaration program)
// do not pull in provisioning, the recipe runner and their imports.
export type RecipeWorkspaceCreateParams = z.infer<typeof WorktreeCreate>

export const RecipeWorkspaceResult = z
  .object({
    worktree: z
      .object({
        id: z.string().min(1),
        repoId: z.string().min(1),
        path: z.string().min(1),
        branch: z.string(),
        instanceId: z.string().optional()
      })
      .passthrough()
  })
  .passthrough()
export type RecipeWorkspaceCreation = z.infer<typeof RecipeWorkspaceResult> & {
  /** The host the provider created for this workspace. */
  host: {
    id: string
    origin: { target: string; runtimeId: string }
    lifecycle: 'per-workspace'
    state: 'running'
    checkoutMode: EphemeralVmCheckoutMode
  }
  hostWarnings?: string[]
}

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

function refuse(message: string, field: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument', data: { field } })
}

/** Refuses what a provider create cannot honor before any machine is started. */
export function assertRecipeWorkspaceCreateSupported(
  params: RecipeWorkspaceCreateParams,
  checkoutMode: EphemeralVmCheckoutMode
): void {
  if (!params.name?.trim()) {
    throw refuse('A provider workspace needs a name.', 'name')
  }
  if (params.startupAgent || params.startupCommand || params.startupDraft) {
    throw refuse(
      'Launch the agent on the new workspace with agent.launch after creation.',
      'startupAgent'
    )
  }
  if (params.automationProvenanceRequest) {
    throw refuse(
      'Provider creates do not take automation provenance requests.',
      'automationProvenanceRequest'
    )
  }
  if (checkoutMode === 'provisioned-root') {
    if (params.sparseCheckout) {
      throw refuse('Provisioned-root recipes do not support sparse checkout.', 'sparseCheckout')
    }
    if (params.runHooks || params.setupDecision === 'run') {
      throw refuse("Provisioned-root recipes run setup in the recipe's create step.", 'setup')
    }
  }
}
