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
  RecipeWorkspaceResult as WorkspaceResult,
  type RecipeWorkspaceCreateParams,
  type RecipeWorkspaceCreation
} from './recipe-workspace-create-params'
import {
  HOST_CREATE_FAILED_CODE,
  type CreatedHostState,
  type HostCreateFailureData,
  type RecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import type { EphemeralVmProvisionIpcResult } from './environment-provision'

export type { RecipeWorkspaceCreateParams, RecipeWorkspaceCreation }
const HOST_OUTCOME = {
  destroyed: 'destroyed',
  failed: 'destroy-failed',
  disabled: 'left-running'
} as const satisfies Record<string, CreatedHostState>

/** Never claim a destroy that did not happen: a failed or disabled one leaves a machine running. */
function environmentOutcomeSentence(
  environment: CreatedHostState,
  runtimeId: string,
  destroyError?: string
): string {
  if (environment === 'destroyed') {
    return 'Orca destroyed the new environment.'
  }
  if (environment === 'left-running') {
    return `The provider has no destroy step, so the environment (runtime ${runtimeId}) is still running; remove it outside Orca.`
  }
  return `The environment (runtime ${runtimeId}) may still be running because destroying it failed${destroyError ? `: ${destroyError}` : ''}. Retry the cleanup from Settings > Cloud VMs in Orca.`
}

/** A failed recipe create; `data` says which step failed and whether its VM was destroyed. */
export class RecipeWorkspaceCreateError extends Error {
  readonly code = HOST_CREATE_FAILED_CODE
  readonly data: HostCreateFailureData

  constructor(message: string, data: HostCreateFailureData) {
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
    /** Canonical `--on` spelling, echoed in results and errors. */
    target: string
    checkoutMode: EphemeralVmCheckoutMode
    /** Provisioned-root recipes receive the branch up front; orca-worktree ones pick it on the VM. */
    branchName?: string
    projectId: string
    signal?: AbortSignal
    onPhase?: (phase: RecipeWorkspaceCreatePhase, detail?: { runtimeId: string }) => void
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
  const { params, target } = args
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
      ? HOST_OUTCOME[provisioned.environmentCleanup]
      : undefined
    const data: HostCreateFailureData = {
      phase,
      target,
      ...(provisioned.errorCode ? { providerCode: provisioned.errorCode } : {}),
      ...(provisioned.errorParams ? { providerParams: provisioned.errorParams } : {}),
      ...(provisioned.runtimeId && environment
        ? { host: { runtimeId: provisioned.runtimeId, state: environment } }
        : {})
    }
    throw new RecipeWorkspaceCreateError(
      provisioned.runtimeId && environment
        ? `${error} ${environmentOutcomeSentence(environment, provisioned.runtimeId)}`
        : error,
      data
    )
  }
  const runtimeId = provisioned.runtime.id
  // Scripts learn the machine's id before any later step can fail or be interrupted.
  args.onPhase?.('host-recorded', { runtimeId })
  try {
    const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
    const environmentId =
      provisioned.connectionType === 'orca-server'
        ? provisioned.environment.id
        : provisioned.environmentId
    if (!environmentId) {
      throw new Error(
        "This provider's environment does not run an Orca server, so only the desktop app can create workspaces on it."
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
      throw new Error('Update Orca on the new environment before creating this workspace.')
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
      host: {
        id: toRuntimeExecutionHostId(environmentId),
        origin: { target, runtimeId },
        lifecycle: 'per-workspace',
        state: 'running',
        checkoutMode
      },
      ...(warnings.length > 0 ? { hostWarnings: warnings } : {})
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
    const state = HOST_OUTCOME[cleaned.outcome]
    const data: HostCreateFailureData = {
      phase: failedPhase,
      target,
      host: { runtimeId, state },
      ...(cleaned.error
        ? { destroyError: redactEphemeralVmRecipeDiagnosticText(cleaned.error) }
        : {})
    }
    throw new RecipeWorkspaceCreateError(
      `${original} ${environmentOutcomeSentence(state, runtimeId, data.destroyError)}`,
      data
    )
  }
}
