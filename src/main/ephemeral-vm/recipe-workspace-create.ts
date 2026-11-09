import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { z } from 'zod'
import type { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import { WorktreeAdoptProvisionedRoot } from '../../shared/rpc-contract/worktree-provisioned-root-params'
import type { EphemeralVmCheckoutMode } from '../../shared/orca-yaml-hook-types'
import {
  getEphemeralVmRecipeResultProjectRoot,
  getEphemeralVmRecipeResultCheckoutMode
} from '../../shared/ephemeral-vm-recipes'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/ephemeral-vm-recipe-diagnostics'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  RECIPE_WORKSPACE_CREATE_FAILED_CODE,
  type RecipeWorkspaceCreateFailureData,
  type RecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import type { EphemeralVmProvisionIpcResult } from './environment-provision'

export type RecipeWorkspaceCreateParams = z.infer<typeof WorktreeCreate>
const WorkspaceResult = z
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
export type RecipeWorkspaceCreation = z.infer<typeof WorkspaceResult> & {
  recipe: {
    id: string
    runtimeId: string
    environmentId: string
    checkoutMode: EphemeralVmCheckoutMode
  }
  environmentWarnings?: string[]
}

/** A failed recipe create; `data` says which step failed and whether its VM was destroyed. */
export class RecipeWorkspaceCreateError extends Error {
  readonly code = RECIPE_WORKSPACE_CREATE_FAILED_CODE
  readonly data: RecipeWorkspaceCreateFailureData

  constructor(message: string, data: RecipeWorkspaceCreateFailureData) {
    super(message)
    this.data = data
  }
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

function forwardedCreateFields(params: RecipeWorkspaceCreateParams): Record<string, unknown> {
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

/**
 * Creates a workspace on a fresh recipe environment: provision (through the same main-side
 * provisioning the desktop uses), register the project on the environment's Orca, then create or
 * adopt the workspace there. Any failure after the VM exists destroys it before rethrowing.
 */
export async function createProvisionedRecipeWorkspace(
  args: {
    params: RecipeWorkspaceCreateParams
    recipeId: string
    checkoutMode: EphemeralVmCheckoutMode
    /** Provisioned-root recipes receive the branch up front; orca-worktree ones pick it on the VM. */
    branchName?: string
    projectId: string
    signal?: AbortSignal
    onPhase?: (phase: RecipeWorkspaceCreatePhase) => void
  },
  ports: {
    provision: (
      onPhase: (phase: RecipeWorkspaceCreatePhase) => void
    ) => Promise<EphemeralVmProvisionIpcResult>
    call: (
      environmentId: string,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<unknown>>
    attach: (runtimeId: string, workspaceId: string) => void
    /** Destroys the VM; `disabled` means the recipe has no destroy step, so nothing ran. */
    cleanup: (
      runtimeId: string
    ) => Promise<{ outcome: 'destroyed' | 'failed' | 'disabled'; error?: string }>
  }
): Promise<RecipeWorkspaceCreation> {
  const { params, recipeId } = args
  assertRecipeWorkspaceCreateSupported(params, args.checkoutMode)
  let phase: RecipeWorkspaceCreatePhase = 'running-create'
  const enter = (next: RecipeWorkspaceCreatePhase): void => {
    phase = next
    args.onPhase?.(next)
  }
  const provisioned = await ports.provision(enter)
  if (!provisioned.ok) {
    throw new RecipeWorkspaceCreateError(redactEphemeralVmRecipeDiagnosticText(provisioned.error), {
      phase,
      recipeId,
      ...(provisioned.errorCode ? { failureCode: provisioned.errorCode } : {}),
      ...(provisioned.errorParams ? { failureParams: provisioned.errorParams } : {})
    })
  }
  const runtimeId = provisioned.runtime.id
  try {
    const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
    const environmentId =
      provisioned.connectionType === 'orca-server'
        ? provisioned.environment.id
        : provisioned.environmentId
    if (!environmentId) {
      throw new Error(
        "This recipe's environment does not run an Orca server, so only the desktop app can create workspaces on it."
      )
    }
    if (checkoutMode === 'provisioned-root' && provisioned.connectionType !== 'ssh') {
      throw new Error('Provisioned-root recipes currently require a direct SSH connection.')
    }
    const call = async (method: string, payload: unknown): Promise<unknown> => {
      args.signal?.throwIfAborted()
      const response = await ports.call(environmentId, method, payload)
      if (!response.ok) {
        throw new Error(redactEphemeralVmRecipeDiagnosticText(response.error.message))
      }
      return response.result
    }
    enter('checking-host')
    const status = z
      .object({ capabilities: z.array(z.string()) })
      .parse(await call('status.get', undefined))
    const requiredCapabilities = [
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
      ...(checkoutMode === 'provisioned-root'
        ? [WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY]
        : []),
      // The CLI checks prompt and presentation support itself when it launches the agent.
      ...(params.createdWithAgent ? [AGENT_LAUNCH_RUNTIME_CAPABILITY] : [])
    ]
    if (!requiredCapabilities.every((capability) => status.capabilities.includes(capability))) {
      throw new Error(
        'Update Orca on the recipe-created environment before creating this workspace.'
      )
    }
    enter('registering-project')
    const projectRoot = getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult)
    const setup = z
      .object({ result: z.object({ repo: z.object({ id: z.string(), path: z.string() }) }) })
      .parse(
        await call('projectHostSetup.setupExistingFolder', {
          projectId: args.projectId,
          hostId: 'local',
          path: projectRoot,
          kind: 'git',
          setupMethod: 'imported-existing-folder'
        })
      )
    enter('creating-workspace')
    const repo = `id:${setup.result.repo.id}`
    let result: z.infer<typeof WorkspaceResult>
    if (checkoutMode === 'provisioned-root') {
      if (
        !args.branchName ||
        provisioned.connectionType !== 'ssh' ||
        !provisioned.expectedRefHead
      ) {
        throw new Error('The provisioned-root recipe did not report its checked-out start ref.')
      }
      result = WorkspaceResult.parse(
        await call(
          'worktree.adoptProvisionedRoot',
          WorktreeAdoptProvisionedRoot.parse({
            ...forwardedCreateFields(params),
            repo,
            branchNameOverride: args.branchName,
            expectedPath: projectRoot,
            expectedRefHead: provisioned.expectedRefHead,
            cliProvenanceRequest: {}
          })
        )
      )
    } else {
      result = WorkspaceResult.parse(
        await call('worktree.create', {
          ...forwardedCreateFields(params),
          repo,
          cliProvenanceRequest: {}
        })
      )
    }
    ports.attach(runtimeId, result.worktree.id)
    const warnings = provisioned.warnings.map((entry) => entry.message)
    return {
      ...result,
      worktree: {
        ...result.worktree,
        hostId: toRuntimeExecutionHostId(environmentId),
        runtimeOwnerEnvironmentId: environmentId
      },
      recipe: { id: recipeId, runtimeId, environmentId, checkoutMode },
      ...(warnings.length > 0 ? { environmentWarnings: warnings } : {})
    }
  } catch (error) {
    const failedPhase = phase
    const original = redactEphemeralVmRecipeDiagnosticText(
      error instanceof Error ? error.message : String(error)
    )
    enter('destroying-after-failure')
    const cleaned = await ports.cleanup(runtimeId).then(
      (result) => result,
      (cleanupError: unknown) => ({
        outcome: 'failed' as const,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      })
    )
    const data: RecipeWorkspaceCreateFailureData = {
      phase: failedPhase,
      recipeId,
      runtimeId,
      environment:
        cleaned.outcome === 'destroyed'
          ? 'destroyed'
          : cleaned.outcome === 'disabled'
            ? 'destroy-disabled'
            : 'destroy-failed',
      ...(cleaned.error
        ? { destroyError: redactEphemeralVmRecipeDiagnosticText(cleaned.error) }
        : {})
    }
    if (cleaned.outcome === 'destroyed') {
      throw new RecipeWorkspaceCreateError(`${original} Orca destroyed the new environment.`, data)
    }
    if (cleaned.outcome === 'disabled') {
      throw new RecipeWorkspaceCreateError(
        `${original} The recipe has no destroy step, so the environment (runtime ${runtimeId}) is still running; remove it with your provider.`,
        data
      )
    }
    // Why: a failed destroy leaves a billed machine; the caller must hear about it, not just the first error.
    throw new RecipeWorkspaceCreateError(
      `${original} The environment (runtime ${runtimeId}) may still be running because destroying it failed${data.destroyError ? `: ${data.destroyError}` : ''}. Retry the cleanup from Settings > Cloud VMs in Orca.`,
      data
    )
  }
}
