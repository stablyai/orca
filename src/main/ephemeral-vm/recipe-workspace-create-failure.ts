import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import type { EnvironmentDoctorCheck } from '../../shared/workspace-setup/environment-doctor/environment-doctor-types'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostic-redaction'
import type { RecipeEnvironmentProvisionResult } from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-environment-provision-result'
import {
  RECIPE_WORKSPACE_CREATE_FAILED_CODE,
  type RecipeEnvironmentOutcome,
  type RecipeWorkspaceCreateFailureData,
  type RecipeWorkspaceCreatePhase
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-create-contract'

export type RecipeEnvironmentCleanup = {
  runtimeId?: string
  environment: RecipeEnvironmentOutcome
  destroyError?: string
}

/** A failed recipe create; `data` says which step failed and what became of its VM. */
export class RecipeWorkspaceCreateError extends Error {
  readonly code = RECIPE_WORKSPACE_CREATE_FAILED_CODE
  readonly data: RecipeWorkspaceCreateFailureData

  constructor(message: string, data: RecipeWorkspaceCreateFailureData) {
    super(message)
    this.data = data
  }
}

/** What a destroy left behind, from the VM record it settled. */
export function destroyedOutcome(runtime: EphemeralVmRuntimeRecord): RecipeEnvironmentCleanup {
  if (runtime.status === 'cleaned') {
    // A recipe without a destroy step is marked cleaned without running anything.
    return { environment: runtime.cleanupStatus === 'disabled' ? 'left-running' : 'destroyed' }
  }
  return {
    environment: 'destroy-failed',
    ...(runtime.cleanupLastError ? { destroyError: runtime.cleanupLastError } : {})
  }
}

/** Provisioning destroys a VM it started but could not connect to; say what that left. */
export function provisionFailureOutcome(
  failure: Extract<RecipeEnvironmentProvisionResult, { ok: false }>
): RecipeEnvironmentCleanup | undefined {
  if (!failure.runtimeId || !failure.environmentCleanup) {
    return undefined
  }
  const environment = {
    destroyed: 'destroyed',
    failed: 'destroy-failed',
    disabled: 'left-running'
  } as const satisfies Record<typeof failure.environmentCleanup, RecipeEnvironmentOutcome>
  return { runtimeId: failure.runtimeId, environment: environment[failure.environmentCleanup] }
}

export function buildRecipeWorkspaceCreateError(failure: {
  recipeId: string
  phase: RecipeWorkspaceCreatePhase
  message: string
  failureCode?: string
  failureParams?: Record<string, string | number>
  outcome?: RecipeEnvironmentCleanup
  environmentChecks?: EnvironmentDoctorCheck[]
}): RecipeWorkspaceCreateError {
  const message = redactEphemeralVmRecipeDiagnosticText(failure.message)
  const { outcome } = failure
  const destroyError = outcome?.destroyError
    ? redactEphemeralVmRecipeDiagnosticText(outcome.destroyError)
    : undefined
  const data: RecipeWorkspaceCreateFailureData = {
    phase: failure.phase,
    recipeId: failure.recipeId,
    ...(failure.failureCode ? { failureCode: failure.failureCode } : {}),
    ...(failure.failureParams ? { failureParams: failure.failureParams } : {}),
    ...(outcome?.runtimeId ? { runtimeId: outcome.runtimeId } : {}),
    ...(outcome ? { environment: outcome.environment } : {}),
    ...(destroyError ? { destroyError } : {}),
    ...(failure.environmentChecks ? { environmentChecks: failure.environmentChecks } : {})
  }
  return new RecipeWorkspaceCreateError(
    outcome
      ? `${message} ${outcomeSentence(outcome.environment, outcome.runtimeId, destroyError)}`
      : message,
    data
  )
}

/** Never claim a destroy that did not happen: a failed or skipped one leaves a billed machine. */
function outcomeSentence(
  environment: RecipeEnvironmentOutcome,
  runtimeId: string | undefined,
  destroyError: string | undefined
): string {
  const named = runtimeId ? ` (VM record ${runtimeId})` : ''
  if (environment === 'destroyed') {
    return 'Orca destroyed the new environment.'
  }
  if (environment === 'left-running') {
    return `The recipe has no destroy step, so the environment${named} is still running; remove it with your provider.`
  }
  return `The environment${named} may still be running because destroying it failed${destroyError ? `: ${destroyError}` : ''}. Retry the cleanup in Orca under Settings > Experimental > Cloud VM.`
}
