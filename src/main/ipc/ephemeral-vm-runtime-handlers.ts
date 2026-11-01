import { app, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { releaseEphemeralVmRuntimeEnvironments } from '../ephemeral-vm/runtime-environment-release'
import { cleanupEphemeralVmRuntime } from '../ephemeral-vm/runtime-service'
import { stopEphemeralVmRuntimeCleanup } from '../ephemeral-vm/runtime-cleanup-control'
import { removeEphemeralVmRuntimeSshTarget } from '../ephemeral-vm/runtime-ssh-cleanup'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload
} from '../../shared/ephemeral-vm-recipe-lifecycle-payload'
import { removeRuntimeOwnedSshTarget } from '../ephemeral-vm/runtime-ssh'
import { getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'
import { resumeEphemeralVmWorkspace } from '../ephemeral-vm/workspace-resume'
import {
  ephemeralVmFailure,
  ephemeralVmFailureFromError
} from '../../shared/ephemeral-vm-failure-copy'
import { invalidateRuntimeEnvironmentTransport } from './runtime-environments/runtime-environments'
import { retireRemovedRuntimeEnvironment } from './runtime-environments/runtime-environment-removal-cleanup'
import { attachEphemeralVmRuntimeToWorkspace } from '../ephemeral-vm/runtime-attachment'

export type EphemeralVmCleanupCommandResult = {
  runtimeId: string
  command: string | null
  payloadJson: string
  cleanupDisabled: boolean
  message?: string
}

export function registerEphemeralVmRuntimeHandlers(store: Store): void {
  ipcMain.removeHandler('ephemeralVm:attachWorkspace')
  ipcMain.removeHandler('ephemeralVm:listRuntimes')
  ipcMain.removeHandler('ephemeralVm:cleanup')
  ipcMain.removeHandler('ephemeralVm:stopCleanup')
  ipcMain.removeHandler('ephemeralVm:resumeWorkspace')
  ipcMain.removeHandler('ephemeralVm:getCleanupCommand')

  ipcMain.handle('ephemeralVm:listRuntimes', (): EphemeralVmRuntimeRecord[] => {
    return listEphemeralVmRuntimes(app.getPath('userData'))
  })

  ipcMain.handle(
    'ephemeralVm:attachWorkspace',
    (_event, args: { runtimeId: string; workspaceId: string }): EphemeralVmRuntimeRecord => {
      return attachEphemeralVmRuntimeToWorkspace({
        userDataPath: app.getPath('userData'),
        runtimeId: args.runtimeId,
        workspaceId: args.workspaceId
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:cleanup',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmRuntimeRecord> => {
      const userDataPath = app.getPath('userData')
      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) => entry.id === args.runtimeId
      )
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
      }
      if (!runtime.repoId) {
        throw new Error(`Ephemeral VM runtime has no repo id: ${args.runtimeId}`)
      }
      let result
      if (runtime.cleanupStatus === 'succeeded') {
        result = { ok: true as const, runtime, skipped: false }
      } else {
        let resolved: ReturnType<typeof getRuntimeRecipeContext>
        try {
          resolved = getRuntimeRecipeContext(store, userDataPath, runtime.id)
        } catch (error) {
          const failed = updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
            status: 'cleanup_failed',
            cleanupStatus: 'failed',
            cleanupLastAttemptAt: Date.now(),
            cleanupLastError: ephemeralVmFailureFromError(error)
          })
          return removeEphemeralVmRuntimeSshTarget({
            userDataPath,
            runtime: failed,
            removeTarget: removeRuntimeOwnedSshTarget
          })
        }
        result = await cleanupEphemeralVmRuntime({
          userDataPath,
          repoPath: resolved.repo.repo.path,
          recipe: resolved.recipe,
          runtimeId: runtime.id
        })
      }
      if (result.ok) {
        try {
          await releaseEphemeralVmRuntimeEnvironments(userDataPath, runtime, (environmentId) => {
            void retireRemovedRuntimeEnvironment(
              environmentId,
              invalidateRuntimeEnvironmentTransport,
              store,
              userDataPath
            )
          })
        } catch {
          // Cleanup of provider resources matters more than hiding a stale local
          // environment row; users can still remove that manually.
        }
      }
      if (!result.ok) {
        return result.runtime
      }
      return removeEphemeralVmRuntimeSshTarget({
        userDataPath,
        runtime: result.runtime,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:stopCleanup',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmRuntimeRecord> => {
      const userDataPath = app.getPath('userData')
      const stopping = stopEphemeralVmRuntimeCleanup({
        userDataPath,
        runtimeId: args.runtimeId
      })
      if (stopping) {
        return (await stopping).runtime
      }

      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) => entry.id === args.runtimeId
      )
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
      }
      if (runtime.cleanupStatus !== 'running') {
        return runtime
      }
      return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastError: ephemeralVmFailure('cleanupInterrupted')
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:resumeWorkspace',
    (_event, args: { workspaceId: string }): Promise<EphemeralVmRuntimeRecord | null> =>
      // The wake itself lives on the host (workspace-resume.ts) so activations without a window resume too.
      resumeEphemeralVmWorkspace(store, args.workspaceId)
  )

  ipcMain.handle(
    'ephemeralVm:getCleanupCommand',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmCleanupCommandResult> => {
      const userDataPath = app.getPath('userData')
      const resolved = getRuntimeRecipeContext(store, userDataPath, args.runtimeId)
      const payload = buildEphemeralVmRecipeCleanupPayload({
        recipe: resolved.recipe,
        context: {
          instanceId: resolved.runtime.id,
          recipeId: resolved.runtime.recipeId,
          projectId: resolved.runtime.projectId,
          workspaceId: resolved.runtime.workspaceId,
          workspaceName: resolved.runtime.workspaceName,
          repoPath: resolved.repo.repo.path
        },
        recipeResult: resolved.runtime.recipeResult
      })
      const payloadJson = JSON.stringify(payload, null, 2)
      if (resolved.recipe.destroyDisabled || !resolved.recipe.destroy) {
        return {
          runtimeId: resolved.runtime.id,
          command: null,
          payloadJson,
          cleanupDisabled: true,
          message: 'Destroy is disabled for this recipe.'
        }
      }
      return {
        runtimeId: resolved.runtime.id,
        command: buildEphemeralVmRecipeCleanupCommand({
          destroyCommand: resolved.recipe.destroy,
          payload
        }),
        payloadJson,
        cleanupDisabled: false
      }
    }
  )
}
