import type { WorktreeCreateOnRecipeParams } from '../../shared/rpc-contract/workspaces/worktree-create-on-recipe-params'
import type { ProjectProviderIdentity } from '../../shared/project/project-types'
import type { EphemeralVmCheckoutMode } from '../../shared/workspace-setup/orca-yaml-hook-types'
import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import type { PendingVmCheckout } from '../../shared/remote-runtime/ephemeral-vm-store/pending-vm-checkouts'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { RuntimeRpcProgress } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { EnvironmentDoctorCheck } from '../../shared/workspace-setup/environment-doctor/environment-doctor-types'
import { toRuntimeExecutionHostId } from '../../shared/execution-host/execution-host'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostic-redaction'
import type {
  RecipeEnvironmentProvisionPhase,
  RecipeEnvironmentProvisionResult
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-environment-provision-result'
import { prepareRecipeWorkspaceTarget } from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-target'
import { cleanupFailedRecipeWorkspace } from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-failed-create-cleanup'
import type {
  RecipeWorkspaceCreatePhase,
  RecipeWorkspaceCreateResult
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-create-contract'
import {
  createRecipeEnvironmentCalls,
  type RecipeEnvironmentCallPort
} from './recipe-environment-calls'
import {
  buildRecipeWorkspaceCreateError,
  destroyedOutcome,
  provisionFailureOutcome,
  type RecipeEnvironmentCleanup
} from './recipe-workspace-create-failure'

// The renderer's limits for the same calls: a create (fetch plus setup) and an adoption.
const CREATE_TIMEOUT_MS = 10 * 60_000
const ADOPT_TIMEOUT_MS = 60_000
// Keeps each progress frame under the envelope's output bound.
const MAX_OUTPUT_CHUNK = 8_192
const CANCELLED = 'The create was cancelled.'

export type RecipeWorkspaceCreatePorts = {
  provision: (options: {
    signal?: AbortSignal
    onPhase: (phase: RecipeEnvironmentProvisionPhase) => void
    onStderr: (chunk: string) => void
  }) => Promise<RecipeEnvironmentProvisionResult>
  call: RecipeEnvironmentCallPort
  /** Destroys the VM and releases what Orca holds for it; resolves with its record. */
  destroy: (runtimeId: string) => Promise<EphemeralVmRuntimeRecord>
  attach: (runtimeId: string, workspaceId: string) => void
  /** Keeps the VM's primary checkout out of every list until the create settles. */
  hideCheckout: (checkout: PendingVmCheckout) => {
    release: () => void
    settleAfterCleanup: (cleanedUp: boolean) => void
  }
}

export type RecipeWorkspaceCreateArgs = {
  params: WorktreeCreateOnRecipeParams
  checkoutMode: EphemeralVmCheckoutMode
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  signal?: AbortSignal
  onProgress?: (progress: RuntimeRpcProgress) => void
}

/**
 * The CLI's equivalent of the new-workspace dialog's Run on > Per-Workspace Environment: provision
 * the recipe and register the project on the host it created (the dialog's own sequence), run the
 * environment checks, create or adopt the workspace there and attach it to its VM record so sleep,
 * wake and delete keep working. Any failure or cancellation after the VM exists destroys it.
 */
export async function createRecipeWorkspace(
  args: RecipeWorkspaceCreateArgs,
  ports: RecipeWorkspaceCreatePorts
): Promise<RecipeWorkspaceCreateResult> {
  const { params, signal } = args
  if (args.checkoutMode === 'provisioned-root' && params.setupDecision === 'run') {
    throw Object.assign(
      new Error(
        "Provisioned-root recipes run setup in the recipe's create step; drop --setup run."
      ),
      { code: 'invalid_argument' }
    )
  }
  let phase: RecipeWorkspaceCreatePhase = 'running-create'
  const enter = (next: RecipeWorkspaceCreatePhase): void => {
    phase = next
    args.onProgress?.({ phase: next })
  }
  const environment = createRecipeEnvironmentCalls(ports.call, signal)
  let provisionFailure: Extract<RecipeEnvironmentProvisionResult, { ok: false }> | undefined
  let provisionedRuntimeId: string | undefined
  let destroyed: RecipeEnvironmentCleanup | undefined
  let hidden: ReturnType<RecipeWorkspaceCreatePorts['hideCheckout']> | undefined
  const destroy = async (runtimeId: string): Promise<EphemeralVmRuntimeRecord> => {
    args.onProgress?.({ phase: 'destroying-after-failure' })
    try {
      const runtime = await ports.destroy(runtimeId)
      destroyed = destroyedOutcome(runtime)
      return runtime
    } catch (error) {
      destroyed = { environment: 'destroy-failed', destroyError: errorMessage(error) }
      throw error
    }
  }

  const target = await prepareRecipeWorkspaceTarget(
    { projectId: args.projectId },
    {
      provision: async () => {
        const provisioned = await ports.provision({
          ...(signal ? { signal } : {}),
          onPhase: enter,
          onStderr: (chunk) => reportOutput(args.onProgress, chunk)
        })
        if (provisioned.ok) {
          provisionedRuntimeId = provisioned.runtime.id
        } else {
          provisionFailure = provisioned
        }
        return provisioned
      },
      describeProvisionFailure: (failure) => failure.error,
      assertEnvironmentCapability: environment.assertCapability,
      setupExistingFolder: async (setupArgs) => {
        const setup = await environment.setupProject(setupArgs, args.projectProviderIdentity)
        if (setup) {
          // Why: until the create adopts it, the VM's primary checkout is not a workspace.
          hidden = ports.hideCheckout({ repoId: setup.repo.id, path: setup.repo.path })
        }
        return setup
      },
      cleanupRuntime: destroy,
      copy: {
        provisionedRootRequiresSsh: () =>
          'Provisioned-root recipes currently require a direct SSH connection.',
        provisionedRootNeedsUpdate: () =>
          'The Orca server on this VM cannot adopt a provisioned root. Update Orca on the VM.',
        projectRootRegistrationFailed: () =>
          'Failed to register the recipe-created project root on the runtime.'
      },
      onRegisteringProject: () => enter('registering-project')
    }
  )
  if (!target.ok) {
    const outcome = provisionFailure
      ? provisionFailureOutcome(provisionFailure)
      : destroyed && { runtimeId: provisionedRuntimeId, ...destroyed }
    throw buildRecipeWorkspaceCreateError({
      recipeId: params.recipeId,
      phase,
      message: signal?.aborted ? CANCELLED : target.error,
      ...(provisionFailure?.errorCode ? { failureCode: provisionFailure.errorCode } : {}),
      ...(provisionFailure?.errorParams ? { failureParams: provisionFailure.errorParams } : {}),
      ...(outcome ? { outcome } : {})
    })
  }

  const { runtimeId, checkoutMode, environmentId } = target
  let environmentChecks: EnvironmentDoctorCheck[] | undefined
  try {
    if (!environmentId) {
      throw new Error("This recipe's environment does not run an Orca server.")
    }
    const repo = `id:${target.setup.repo.id}`
    const repoPath = target.setup.repo.path
    enter('checking-environment')
    const checked = await environment.checkEnvironment(environmentId, repoPath)
    if (checked && !checked.ok) {
      environmentChecks = checked.checks.filter((check) => check.status === 'fail')
      throw new Error(
        'The new environment failed its checks. Fix the recipe or its image, then retry; `orca vm env doctor` in a workspace on it runs the same checks.'
      )
    }
    enter('creating-workspace')
    const created = parseCreatedWorkspace(
      checkoutMode === 'provisioned-root'
        ? await environment.call(
            environmentId,
            'worktree.adoptProvisionedRoot',
            {
              ...forwardedCreateFields(params),
              repo,
              expectedPath: repoPath,
              ...(target.expectedRefHead ? { expectedRefHead: target.expectedRefHead } : {})
            },
            ADOPT_TIMEOUT_MS
          )
        : await environment.call(
            environmentId,
            'worktree.create',
            {
              ...forwardedCreateFields(params),
              repo,
              ...(params.setupDecision ? { setupDecision: params.setupDecision } : {}),
              // Provenance only: the caller's terminal belongs to this computer, not the new host.
              cliProvenanceRequest: {}
            },
            CREATE_TIMEOUT_MS
          )
    )
    const warnings = [
      ...target.warnings.map((warning) => warning.message),
      ...(created.warning ? [created.warning] : [])
    ]
    try {
      ports.attach(runtimeId, created.worktree.id)
    } catch (error) {
      warnings.push(
        `Orca created the workspace but could not link it to its VM record, so sleep, wake and delete will not manage the VM: ${errorMessage(error)}`
      )
    }
    hidden?.release()
    const hostId = toRuntimeExecutionHostId(environmentId)
    return {
      worktree: { ...created.worktree, hostId },
      host: { id: hostId, environmentId, runtimeId, recipeId: params.recipeId, checkoutMode },
      ...(warnings.length > 0 ? { warnings } : {})
    }
  } catch (error) {
    const failedPhase = phase
    const cleanedUp = await cleanupFailedRecipeWorkspace(
      {
        runtimeId,
        checkoutMode,
        projectHostSetupId: target.setup.setup.id,
        hostId: target.setup.setup.hostId
      },
      {
        deleteProjectHostSetup: (setupId) =>
          environmentId ? environment.deleteProject(environmentId, setupId) : Promise.resolve(null),
        cleanupRuntime: destroy,
        reportSetupError: (setupError) =>
          console.error(
            '[vm-recipes] Could not remove the provisioned-root project setup:',
            setupError
          ),
        reportRuntimeError: (runtimeError) =>
          console.error(
            '[vm-recipes] Could not destroy the VM after its create failed:',
            runtimeError
          )
      }
    )
    hidden?.settleAfterCleanup(cleanedUp)
    throw buildRecipeWorkspaceCreateError({
      recipeId: params.recipeId,
      phase: failedPhase,
      message: signal?.aborted ? CANCELLED : errorMessage(error),
      outcome: { runtimeId, ...(destroyed ?? { environment: 'destroy-failed' }) },
      ...(environmentChecks ? { environmentChecks } : {})
    })
  }
}

// Fields the new host's own create understands; lineage, activation and the caller's terminal stay here.
function forwardedCreateFields(params: WorktreeCreateOnRecipeParams): Record<string, unknown> {
  const fields = {
    name: params.name,
    displayName: params.displayName,
    displayNameKind: params.displayNameKind,
    baseBranch: params.baseBranch,
    branchNameOverride: params.branchNameOverride,
    comment: params.comment,
    createdWithAgent: params.createdWithAgent
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function parseCreatedWorkspace(result: unknown): {
  worktree: RuntimeWorktreeRecord
  warning?: string
} {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('worktree' in result) ||
    !isWorktreeRecord(result.worktree)
  ) {
    throw new Error('The new environment did not report the workspace it created.')
  }
  const warning = 'warning' in result && typeof result.warning === 'string' ? result.warning : ''
  return warning ? { worktree: result.worktree, warning } : { worktree: result.worktree }
}

// The new host's own Orca answered; its record passes through to the CLI as that host shows it.
function isWorktreeRecord(value: unknown): value is RuntimeWorktreeRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0
  )
}

function reportOutput(onProgress: RecipeWorkspaceCreateArgs['onProgress'], chunk: string): void {
  if (!onProgress || !chunk) {
    return
  }
  const text = redactEphemeralVmRecipeDiagnosticText(chunk)
  for (let start = 0; start < text.length; start += MAX_OUTPUT_CHUNK) {
    onProgress({ output: text.slice(start, start + MAX_OUTPUT_CHUNK) })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
