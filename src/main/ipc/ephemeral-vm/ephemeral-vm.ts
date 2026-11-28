import { app, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { EphemeralVmRecipeDoctorResult } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipes'
// Import the Node-only doctor directly so browser consumers of the barrel do not bundle fs/path.
import { doctorEphemeralVmRecipe } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-doctor'
import { reconcileInterruptedEphemeralVmProvisionsOnStartup } from '../../ephemeral-vm/runtime-provisioning-persistence'
import {
  getRecipeRepo,
  listRecipeCatalog,
  listRecipes,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'
import type { PluginService } from '../../plugins/plugin-service'
import { getApprovedPluginVmRecipes } from '../../plugins/contributions/plugin-approved-vm-recipes'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  cancelEphemeralVmProvision,
  handleEphemeralVmProvision,
  type EphemeralVmProvisionIpcArgs,
  type EphemeralVmProvisionIpcResult
} from './ephemeral-vm-provision-handler'

export type { EphemeralVmProvisionIpcResult } from './ephemeral-vm-provision-handler'

export function registerEphemeralVmHandlers(
  store: Store,
  pluginService?: PluginService,
  ipc: IpcHandleRegistrar = ipcMain,
  options?: { skipStartupReconcile?: boolean }
): void {
  if (ipc === ipcMain) {
    for (const ch of [
      'listRecipes',
      'listRecipeCatalog',
      'doctor',
      'provision',
      'cancelProvision'
    ]) {
      ipcMain.removeHandler(`ephemeralVm:${ch}`)
    }
  }
  registerEphemeralVmRuntimeHandlers(store, ipc)
  if (!options?.skipStartupReconcile) {
    reconcileInterruptedEphemeralVmProvisionsOnStartup(app.getPath('userData'))
  }

  ipc.handle('ephemeralVm:listRecipes', async (_event, args: { repoId: string }) => {
    return listRecipes(store, args.repoId, await getApprovedPluginVmRecipes(pluginService))
  })

  ipc.handle(
    'ephemeralVm:listRecipeCatalog',
    async (): Promise<EphemeralVmRecipeCatalogEntry[]> => {
      return listRecipeCatalog(store, await getApprovedPluginVmRecipes(pluginService))
    }
  )

  ipc.handle(
    'ephemeralVm:doctor',
    async (
      _event,
      args: { repoId: string; recipeId: string }
    ): Promise<EphemeralVmRecipeDoctorResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return repo.doctor(args.recipeId)
      }
      const pluginRecipes = await getApprovedPluginVmRecipes(pluginService)
      return doctorEphemeralVmRecipe({
        repoPath: repo.repo.path,
        recipeId: args.recipeId,
        recipes: listRecipes(store, args.repoId, pluginRecipes).recipes,
        localExecutionSupported: true
      })
    }
  )

  ipc.handle(
    'ephemeralVm:provision',
    (event, args: EphemeralVmProvisionIpcArgs): Promise<EphemeralVmProvisionIpcResult> =>
      handleEphemeralVmProvision(event, args, store, pluginService)
  )

  ipc.handle(
    'ephemeralVm:cancelProvision',
    (_event, args: { provisionId: string }): { cancelled: boolean } =>
      cancelEphemeralVmProvision(args.provisionId)
  )
}
