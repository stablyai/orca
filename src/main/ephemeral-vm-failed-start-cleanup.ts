import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { ProvisionEphemeralVmRuntimeArgs } from './ephemeral-vm-runtime-service'
import {
  runEphemeralVmRecipeCleanup,
  type EphemeralVmRecipeContext
} from './ephemeral-vm-recipe-runner'

type FailedStart = {
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}

export async function cleanupFailedEphemeralVmStart(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<void> {
  const cleanupError = await getCleanupError(args, start)
  if (cleanupError === null) {
    return
  }

  const now = args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.recipeResult)
  upsertEphemeralVmRuntime(args.userDataPath, {
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
    cleanupLastError: cleanupError,
    createdAt: now,
    updatedAt: now,
    recipeResult: start.recipeResult
  })
}

async function getCleanupError(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<string | null> {
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
    return cleanup.ok
      ? 'Destroy is disabled for this recipe.'
      : (cleanup.error ?? 'Destroy failed.')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
