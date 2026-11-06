import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
} from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { z } from 'zod'
import type { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import { WorktreeAdoptProvisionedRoot } from '../../shared/rpc-contract/worktree-provisioned-root-params'
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
  recipeEnvironmentId: string
  warning?: string
}

/** Reuses the desktop's provision, project setup and checked-root adoption on the serving host. */
export async function createProvisionedRecipeWorkspace(
  args: {
    params: RecipeWorkspaceCreateParams
    branchName: string
    projectId: string
  },
  ports: {
    provision: () => Promise<EphemeralVmProvisionIpcResult>
    call: (
      environmentId: string,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<unknown>>
    attach: (runtimeId: string, workspaceId: string) => void
    cleanup: (runtimeId: string) => Promise<void>
  }
): Promise<RecipeWorkspaceCreation> {
  const { params } = args
  if (!params.name?.trim()) {
    throw new Error('A recipe workspace requires a name.')
  }
  if (params.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  if (params.startupAgent || params.startupCommand || params.startupDraft) {
    throw new Error(
      'Launch the agent on the recipe-created workspace with agent.launch after creation.'
    )
  }
  if (params.runHooks || params.setupDecision === 'run') {
    throw new Error('Provisioned-root recipes must run setup in their create script.')
  }
  if (params.automationProvenanceRequest) {
    throw new Error(
      'Recipe workspace creation does not yet support automation provenance requests.'
    )
  }
  const provisioned = await ports.provision()
  if (!provisioned.ok) {
    throw new Error(redactEphemeralVmRecipeDiagnosticText(provisioned.error))
  }
  const runtimeId = provisioned.runtime.id
  try {
    if (
      getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult) !==
        'provisioned-root' ||
      provisioned.connectionType !== 'ssh' ||
      !provisioned.environmentId ||
      !provisioned.expectedRefHead
    ) {
      throw new Error('CLI recipe creation requires a provisioned-root SSH recipe served by Orca.')
    }
    const environmentId = provisioned.environmentId
    const call = async (method: string, payload: unknown): Promise<unknown> => {
      const response = await ports.call(environmentId, method, payload)
      if (!response.ok) {
        throw new Error(redactEphemeralVmRecipeDiagnosticText(response.error.message))
      }
      return response.result
    }
    const status = z
      .object({ capabilities: z.array(z.string()) })
      .parse(await call('status.get', undefined))
    const requiredCapabilities = [
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
      WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY,
      ...(params.createdWithAgent
        ? [
            AGENT_LAUNCH_RUNTIME_CAPABILITY,
            AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
            AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
          ]
        : [])
    ]
    if (!requiredCapabilities.every((capability) => status.capabilities.includes(capability))) {
      throw new Error('Update Orca on the recipe-created host before adopting this workspace.')
    }
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
    const result = WorkspaceResult.parse(
      await call(
        'worktree.adoptProvisionedRoot',
        WorktreeAdoptProvisionedRoot.parse({
          ...params,
          repo: `id:${setup.result.repo.id}`,
          branchNameOverride: args.branchName,
          expectedPath: projectRoot,
          expectedRefHead: provisioned.expectedRefHead
        })
      )
    )
    if (params.comment !== undefined) {
      await call('worktree.set', { worktree: `id:${result.worktree.id}`, comment: params.comment })
    }
    ports.attach(runtimeId, result.worktree.id)
    const warning = provisioned.warnings.map((entry) => entry.message).join(' ')
    return {
      ...result,
      worktree: {
        ...result.worktree,
        hostId: toRuntimeExecutionHostId(environmentId),
        runtimeOwnerEnvironmentId: environmentId
      },
      recipeEnvironmentId: environmentId,
      ...(warning ? { warning } : {})
    }
  } catch (error) {
    const cleanupFailure = await ports.cleanup(runtimeId).then(
      () => null,
      (cleanupError: unknown) => cleanupError
    )
    if (cleanupFailure === null) {
      throw error
    }
    // Why: a failed destroy leaves a billed machine; the caller must hear about it, not just the first error.
    const original = error instanceof Error ? error.message : String(error)
    const cleanup =
      cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
    throw new Error(
      `${original} The VM (runtime ${runtimeId}) may still be running because its cleanup failed: ${redactEphemeralVmRecipeDiagnosticText(cleanup)}. Retry cleanup from the VM runtimes in Orca settings.`
    )
  }
}
