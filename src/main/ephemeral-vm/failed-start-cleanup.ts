import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeResult
} from '../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  upsertEphemeralVmRuntime,
  upsertEphemeralVmRuntimeRollbackRecovery
} from '../../shared/ephemeral-vm-runtime-store'
import {
  toCleanupLastErrorFields,
  ephemeralVmFailure,
  ephemeralVmFailureFromError,
  pickEphemeralVmFailureCode,
  type EphemeralVmFailure
} from '../../shared/ephemeral-vm-failure-copy'
import type { ProvisionEphemeralVmRuntimeArgs } from './runtime-service'
import {
  runEphemeralVmRecipeCleanup,
  type EphemeralVmRecipeContext
} from '../../shared/ephemeral-vm-recipe-runner'

type FailedStart = {
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}

export async function cleanupFailedEphemeralVmStart(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<boolean> {
  const cleanupError = await getCleanupError(args, start)
  if (cleanupError === null) {
    return true
  }

  const now = args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.recipeResult)
  const recovery: EphemeralVmRuntimeRecord = {
    id: start.context.instanceId ?? start.context.recipeId,
    recipeId: args.recipe.id,
    recipe: args.recipe,
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    status: 'cleanup_failed',
    connectionMode: connection.type,
    cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'failed',
    ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
    cleanupLastAttemptAt: now,
    ...toCleanupLastErrorFields(cleanupError),
    createdAt: now,
    updatedAt: now,
    recipeResult: start.recipeResult
  }
  try {
    upsertEphemeralVmRuntime(args.userDataPath, recovery)
  } catch (error) {
    if (!args.recipe.checkoutMode) {
      throw error
    }
    // Retain cleanup retry metadata even if the companion feature file is unreadable.
    upsertEphemeralVmRuntimeRollbackRecovery(args.userDataPath, recovery)
  }
  return false
}

async function getCleanupError(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<EphemeralVmFailure | null> {
  try {
    const cleanup = await runEphemeralVmRecipeCleanup({
      repoPath: args.repoPath,
      recipe: args.recipe,
      context: start.context,
      recipeResult: start.recipeResult,
      signal: args.signal,
      onStdout: args.onStdout,
      onStderr: args.onStderr
    })
    if (cleanup.ok && !cleanup.skipped) {
      return null
    }
    if (cleanup.ok) {
      return ephemeralVmFailure('destroyDisabled')
    }
    return cleanup.error
      ? { error: cleanup.error, ...pickEphemeralVmFailureCode(cleanup) }
      : ephemeralVmFailure('destroyFailed')
  } catch (error) {
    return ephemeralVmFailureFromError(error)
  }
}
