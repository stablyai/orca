// orca.yaml environment recipes and plugin VM recipes as an environment provider: each lifecycle
// call runs the recipe's shell step, exactly as the runtime service did before the driver seam.
import { z } from 'zod'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  EphemeralVmRecipeResultSchema,
  type EphemeralVmRecipeResult,
  type JsonValue
} from '../../shared/ephemeral-vm-recipes'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeStart,
  runEphemeralVmRecipeSuspend,
  type EphemeralVmRecipeCleanupArgs,
  type EphemeralVmRecipeContext,
  type EphemeralVmRecipeLifecycleArgs,
  type EphemeralVmRecipeStartArgs
} from '../../shared/ephemeral-vm-recipe-runner'
import { EPHEMERAL_VM_FAILURE_COPY } from '../../shared/ephemeral-vm-failure-copy'
import { getProvisionedRootResumeIntegrityError } from '../ephemeral-vm/resume-integrity'
import {
  EnvironmentProviderError,
  isEnvironmentProviderError,
  type EnvironmentCreateSpec,
  type EnvironmentHandle,
  type EnvironmentProviderCallContext,
  type EnvironmentProviderCapabilities,
  type EnvironmentProviderDriver,
  type EnvironmentReady,
  type EnvironmentStatus,
  type EnvironmentStatusSnapshot
} from './environment-provider-driver'

export const SHELL_RECIPE_DRIVER_ID = 'shell-recipe'

type RecipeStepArgs<T> = Omit<T, 'recipe' | 'repoPath'>

type RecipeStepFailure = {
  error?: string
  errorCode?: string
  exitCode: number | null
  aborted?: true
  timedOut?: true
}

const DriverStateSchema = z.object({
  recipeResult: EphemeralVmRecipeResultSchema,
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional()
})

export class ShellRecipeDriver implements EnvironmentProviderDriver {
  readonly id = SHELL_RECIPE_DRIVER_ID
  readonly capabilities: EnvironmentProviderCapabilities
  // Recipes have no status step, so status only covers calls this instance ran; the runtime
  // record stays the persisted source of truth.
  private readonly statuses = new Map<string, EnvironmentStatus>()

  constructor(
    private readonly recipe: OrcaVmRecipe,
    private readonly repoPath: string
  ) {
    this.capabilities = {
      memoryPause: false,
      maxSessionMs: null,
      fsPersistOnStop: Boolean(recipe.suspend && recipe.resume),
      idleStopMs: null
    }
  }

  // Recipe-shaped steps keep stdout/stderr and failure copy for runtime records and diagnostics.
  runCreate(args: RecipeStepArgs<EphemeralVmRecipeStartArgs>) {
    return runEphemeralVmRecipeStart({ ...args, recipe: this.recipe, repoPath: this.repoPath })
  }

  runSuspend(args: RecipeStepArgs<EphemeralVmRecipeLifecycleArgs>) {
    return runEphemeralVmRecipeSuspend({ ...args, recipe: this.recipe, repoPath: this.repoPath })
  }

  runResume(args: RecipeStepArgs<EphemeralVmRecipeLifecycleArgs>) {
    return runEphemeralVmRecipeResume({ ...args, recipe: this.recipe, repoPath: this.repoPath })
  }

  runDestroy(args: RecipeStepArgs<EphemeralVmRecipeCleanupArgs>) {
    return runEphemeralVmRecipeCleanup({ ...args, recipe: this.recipe, repoPath: this.repoPath })
  }

  create(spec: EnvironmentCreateSpec, ctx: EnvironmentProviderCallContext = {}) {
    return catalogued(() => this.createOnce(spec, ctx))
  }

  suspend(handle: EnvironmentHandle, ctx: EnvironmentProviderCallContext = {}) {
    return catalogued(() => this.suspendOnce(handle, ctx))
  }

  resume(handle: EnvironmentHandle, ctx: EnvironmentProviderCallContext = {}) {
    return catalogued(() => this.resumeOnce(handle, ctx))
  }

  destroy(handle: EnvironmentHandle, ctx: EnvironmentProviderCallContext = {}) {
    return catalogued(() => this.destroyOnce(handle, ctx))
  }

  private async createOnce(
    spec: EnvironmentCreateSpec,
    ctx: EnvironmentProviderCallContext
  ): Promise<EnvironmentReady> {
    ctx.onProgress?.({ phase: 'provisioning' })
    const start = await this.runCreate({
      context: {
        projectId: spec.projectId,
        workspaceId: spec.workspaceId,
        workspaceName: spec.workspaceName,
        repoUrl: spec.repo?.url,
        ref: spec.repo?.ref
      },
      signal: ctx.signal
    })
    if (!start.ok) {
      const error = toProviderError(start)
      if (start.recipeResult) {
        // The VM exists even though Orca rejected its result; release it rather than leak it.
        const cleanup = await this.runDestroy({
          context: start.context,
          recipeResult: start.recipeResult
        })
        if (!cleanup.ok || cleanup.skipped) {
          const detail = cleanup.error ?? EPHEMERAL_VM_FAILURE_COPY.destroyDisabled
          throw new EnvironmentProviderError(error.code, `${error.message} ${detail}`, error.reason)
        }
      }
      throw error
    }
    const handle = toHandle(start.context, start.result)
    this.statuses.set(handle.environmentId, 'running')
    return toReady(handle, start.result)
  }

  private async suspendOnce(
    handle: EnvironmentHandle,
    ctx: EnvironmentProviderCallContext
  ): Promise<EnvironmentStatusSnapshot> {
    const { context, recipeResult } = this.readHandle(handle)
    ctx.onProgress?.({ phase: 'suspending' })
    const suspend = await this.runSuspend({ context, recipeResult, signal: ctx.signal })
    if (!suspend.ok) {
      throw toProviderError(suspend)
    }
    // No suspend step: the VM keeps running.
    const status = suspend.skipped ? 'running' : 'suspended'
    this.statuses.set(handle.environmentId, status)
    return { status, session: null }
  }

  private async resumeOnce(
    handle: EnvironmentHandle,
    ctx: EnvironmentProviderCallContext
  ): Promise<EnvironmentReady> {
    const { context, recipeResult } = this.readHandle(handle)
    ctx.onProgress?.({ phase: 'resuming' })
    const resume = await this.runResume({ context, recipeResult, signal: ctx.signal })
    if (!resume.ok) {
      throw toProviderError(resume)
    }
    const result = resume.skipped ? recipeResult : resume.result
    const integrityError = getProvisionedRootResumeIntegrityError(recipeResult, result)
    if (integrityError) {
      throw new EnvironmentProviderError('conflict', integrityError)
    }
    this.statuses.set(handle.environmentId, 'running')
    return toReady(toHandle(context, result), result)
  }

  private async destroyOnce(
    handle: EnvironmentHandle,
    ctx: EnvironmentProviderCallContext
  ): Promise<void> {
    if (this.statuses.get(handle.environmentId) === 'destroyed') {
      return
    }
    const { context, recipeResult } = this.readHandle(handle)
    ctx.onProgress?.({ phase: 'destroying' })
    const cleanup = await this.runDestroy({ context, recipeResult, signal: ctx.signal })
    if (!cleanup.ok) {
      throw toProviderError(cleanup)
    }
    if (cleanup.skipped) {
      throw new EnvironmentProviderError(
        'invalid_request',
        EPHEMERAL_VM_FAILURE_COPY.destroyDisabled,
        'destroyDisabled'
      )
    }
    this.statuses.set(handle.environmentId, 'destroyed')
  }

  async status(handle: EnvironmentHandle): Promise<EnvironmentStatusSnapshot> {
    const status = this.statuses.get(handle.environmentId)
    if (!status) {
      throw new EnvironmentProviderError('not_found', 'This driver has not run that environment.')
    }
    return { status, session: null }
  }

  private readHandle(handle: EnvironmentHandle): {
    context: EphemeralVmRecipeContext
    recipeResult: EphemeralVmRecipeResult
  } {
    if (handle.driverId !== this.id) {
      throw new EnvironmentProviderError('invalid_request', 'Handle belongs to another driver.')
    }
    if (this.statuses.get(handle.environmentId) === 'destroyed') {
      throw new EnvironmentProviderError('not_found', 'Environment was destroyed.')
    }
    const state = DriverStateSchema.safeParse(handle.driverState)
    if (!state.success) {
      throw new EnvironmentProviderError('invalid_request', 'Handle has no recipe result.')
    }
    const { recipeResult, ...fields } = state.data
    return {
      context: {
        ...fields,
        instanceId: handle.environmentId,
        recipeId: this.recipe.id,
        repoPath: this.repoPath
      },
      recipeResult
    }
  }
}

function toHandle(
  context: EphemeralVmRecipeContext,
  recipeResult: EphemeralVmRecipeResult
): EnvironmentHandle {
  const { instanceId, projectId, workspaceId, workspaceName } = context
  if (!instanceId) {
    throw new EnvironmentProviderError('invalid_response', 'Recipe run has no instance id.')
  }
  // Round-trip through JSON so the persisted state is plain data (drops undefined fields).
  const driverState: Record<string, JsonValue> = JSON.parse(
    JSON.stringify({ recipeResult, projectId, workspaceId, workspaceName })
  )
  return {
    driverId: SHELL_RECIPE_DRIVER_ID,
    environmentId: instanceId,
    driverState
  }
}

function toReady(handle: EnvironmentHandle, result: EphemeralVmRecipeResult): EnvironmentReady {
  return { handle, result, session: { startedAt: Date.now(), deadlineAt: null } }
}

// Spawn errors and a missing repo dir surface as plain errors; the contract promises catalogued ones.
async function catalogued<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isEnvironmentProviderError(error)) {
      throw error
    }
    throw new EnvironmentProviderError(
      'unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function toProviderError(failure: RecipeStepFailure): EnvironmentProviderError {
  const code = failure.aborted
    ? 'aborted'
    : failure.timedOut
      ? 'timeout'
      : // The step exited cleanly but Orca rejected what it printed.
        failure.exitCode === 0
        ? 'invalid_response'
        : 'unavailable'
  return new EnvironmentProviderError(
    code,
    failure.error ?? 'Recipe step failed.',
    failure.errorCode ?? null
  )
}
