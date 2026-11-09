import { app, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { cleanupOwnedEphemeralVmRuntime } from '../ephemeral-vm/owned-runtime-cleanup'
import { stopEphemeralVmRuntimeCleanup } from '../ephemeral-vm/runtime-cleanup-control'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload
} from '../../shared/ephemeral-vm-recipe-lifecycle-payload'
import { getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'
import { ephemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { attachEphemeralVmRuntimeToWorkspace } from '../ephemeral-vm/runtime-attachment'
import { forgetInterruptedEphemeralVmProvision } from '../ephemeral-vm/runtime-provisioning-persistence'

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
  ipcMain.removeHandler('ephemeralVm:forgetRuntime')
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
      return cleanupOwnedEphemeralVmRuntime(store, app.getPath('userData'), args.runtimeId)
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

  ipcMain.handle('ephemeralVm:forgetRuntime', (_event, args: { runtimeId: string }): void => {
    forgetInterruptedEphemeralVmProvision(app.getPath('userData'), args.runtimeId)
  })

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
          repoPath: resolved.repoPath
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
