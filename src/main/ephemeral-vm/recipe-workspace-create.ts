import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { z } from 'zod'
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
  assertRecipeWorkspaceCreateSupported,
  forwardedCreateFields,
  type RecipeWorkspaceCreateParams
} from './recipe-workspace-create-params'
import {
  RECIPE_WORKSPACE_CREATE_FAILED_CODE,
  type RecipeWorkspaceCreateFailureData,
  type RecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import type { EphemeralVmProvisionIpcResult } from './environment-provision'

export type { RecipeWorkspaceCreateParams }
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

const ENVIRONMENT_OUTCOME = {
  destroyed: 'destroyed',
  failed: 'destroy-failed',
  disabled: 'destroy-disabled'
} as const satisfies Record<string, NonNullable<RecipeWorkspaceCreateFailureData['environment']>>

/** Never claim a destroy that did not happen: a failed or disabled one leaves a billed machine. */
function environmentOutcomeSentence(
  environment: NonNullable<RecipeWorkspaceCreateFailureData['environment']>,
  runtimeId: string,
  destroyError?: string
): string {
  if (environment === 'destroyed') {
    return 'Orca destroyed the new environment.'
  }
  if (environment === 'destroy-disabled') {
    return `The recipe has no destroy step, so the environment (runtime ${runtimeId}) is still running; remove it with your provider.`
  }
  return `The environment (runtime ${runtimeId}) may still be running because destroying it failed${destroyError ? `: ${destroyError}` : ''}. Retry the cleanup from Settings > Cloud VMs in Orca.`
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
    const error = redactEphemeralVmRecipeDiagnosticText(provisioned.error)
    const environment = provisioned.environmentCleanup
      ? ENVIRONMENT_OUTCOME[provisioned.environmentCleanup]
      : undefined
    const data: RecipeWorkspaceCreateFailureData = {
      phase,
      recipeId,
      ...(provisioned.errorCode ? { failureCode: provisioned.errorCode } : {}),
      ...(provisioned.errorParams ? { failureParams: provisioned.errorParams } : {}),
      ...(provisioned.runtimeId ? { runtimeId: provisioned.runtimeId } : {}),
      ...(environment ? { environment } : {})
    }
    throw new RecipeWorkspaceCreateError(
      provisioned.runtimeId && environment
        ? `${error} ${environmentOutcomeSentence(environment, provisioned.runtimeId)}`
        : error,
      data
    )
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
      environment: ENVIRONMENT_OUTCOME[cleaned.outcome],
      ...(cleaned.error
        ? { destroyError: redactEphemeralVmRecipeDiagnosticText(cleaned.error) }
        : {})
    }
    throw new RecipeWorkspaceCreateError(
      `${original} ${environmentOutcomeSentence(data.environment ?? 'destroy-failed', runtimeId, data.destroyError)}`,
      data
    )
  }
}
