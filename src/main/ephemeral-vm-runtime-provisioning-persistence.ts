import { randomUUID } from 'node:crypto'
import { assertEphemeralVmRuntimeCheckoutModeCanPersist } from '../shared/ephemeral-vm-runtime-feature-store'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  listEphemeralVmRuntimes,
  removeEphemeralVmRuntime,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type {
  ProvisionEphemeralVmRuntimeArgs,
  ProvisionEphemeralVmRuntimeResult
} from './ephemeral-vm-runtime-service'
import { cleanupFailedEphemeralVmStart } from './ephemeral-vm-failed-start-cleanup'

export type EphemeralVmCompatibilityPersistence = {
  instanceId: string
  createdAt: number
}

export function prepareEphemeralVmCompatibilityPersistence(
  args: ProvisionEphemeralVmRuntimeArgs
): EphemeralVmCompatibilityPersistence | null {
  if (!args.recipe.checkoutMode) {
    return null
  }
  listEphemeralVmRuntimes(args.userDataPath)
  const compatibility = {
    instanceId: `orca-${randomUUID()}`,
    createdAt: args.now ?? Date.now()
  }
  assertEphemeralVmRuntimeCheckoutModeCanPersist(args.userDataPath, {
    id: compatibility.instanceId,
    recipeId: args.recipe.id,
    createdAt: compatibility.createdAt,
    checkoutMode: args.recipe.checkoutMode
  })
  return compatibility
}

export async function persistProvisionedEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: Extract<ProvisionEphemeralVmRuntimeResult, { ok: true }>['start'],
  compatibility: EphemeralVmCompatibilityPersistence | null
): Promise<EphemeralVmRuntimeRecord> {
  const now = compatibility?.createdAt ?? args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  try {
    return upsertEphemeralVmRuntime(args.userDataPath, {
      id: start.context.instanceId ?? start.context.recipeId,
      recipeId: args.recipe.id,
      recipe: args.recipe,
      ...(args.repoId ? { repoId: args.repoId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
      status: 'running',
      connectionMode: connection.type,
      cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'not_started',
      ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
      createdAt: now,
      updatedAt: now,
      recipeResult: start.result
    })
  } catch (error) {
    if (compatibility) {
      const cleaned = await cleanupFailedEphemeralVmStart(args, {
        context: start.context,
        recipeResult: start.result
      })
      if (
        cleaned &&
        listEphemeralVmRuntimes(args.userDataPath).some(
          (runtime) => runtime.id === compatibility.instanceId
        )
      ) {
        removeEphemeralVmRuntime(args.userDataPath, compatibility.instanceId)
      }
    }
    throw error
  }
}
