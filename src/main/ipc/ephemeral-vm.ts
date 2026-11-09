import { app, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/ephemeral-vm-recipe-diagnostics'
// Import the Node-only doctor directly so browser consumers of the barrel do not bundle fs/path.
import { doctorEphemeralVmRecipe } from '../../shared/ephemeral-vm-recipe-doctor'
import { reconcileInterruptedEphemeralVmProvisionsOnStartup } from '../ephemeral-vm/runtime-provisioning-persistence'
import {
  provisionRecipeEnvironment,
  type EphemeralVmProvisionIpcResult
} from '../ephemeral-vm/environment-provision'
import {
  getRecipeRepo,
  listRecipeCatalog,
  listRecipes,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'
import type { PluginService } from '../plugins/plugin-service'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'

const activeProvisionControllers = new Map<string, AbortController>()

export type { EphemeralVmProvisionIpcResult }

export function registerEphemeralVmHandlers(store: Store, pluginService?: PluginService): void {
  ipcMain.removeHandler('ephemeralVm:listRecipes')
  ipcMain.removeHandler('ephemeralVm:listRecipeCatalog')
  ipcMain.removeHandler('ephemeralVm:doctor')
  ipcMain.removeHandler('ephemeralVm:provision')
  ipcMain.removeHandler('ephemeralVm:cancelProvision')
  registerEphemeralVmRuntimeHandlers(store)
  reconcileInterruptedEphemeralVmProvisionsOnStartup(app.getPath('userData'))

  ipcMain.handle('ephemeralVm:listRecipes', async (_event, args: { repoId: string }) => {
    return listRecipes(store, args.repoId, await getApprovedPluginVmRecipes(pluginService))
  })

  ipcMain.handle(
    'ephemeralVm:listRecipeCatalog',
    async (): Promise<EphemeralVmRecipeCatalogEntry[]> => {
      return listRecipeCatalog(store, await getApprovedPluginVmRecipes(pluginService))
    }
  )

  ipcMain.handle(
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

  ipcMain.handle(
    'ephemeralVm:provision',
    async (
      _event,
      args: {
        repoId: string
        recipeId: string
        workspaceName?: string
        projectId?: string
        workspaceId?: string
        branch?: string
        ref?: string
        provisionId?: string
      }
    ): Promise<EphemeralVmProvisionIpcResult> => {
      const controller = args.provisionId ? new AbortController() : null
      if (args.provisionId && controller) {
        activeProvisionControllers.set(args.provisionId, controller)
      }
      const sendProvisionEvent = (stream: 'stdout' | 'stderr', chunk: string): void => {
        if (!args.provisionId) {
          return
        }
        _event.sender.send('ephemeralVm:provisionEvent', {
          provisionId: args.provisionId,
          stream,
          chunk: redactEphemeralVmRecipeDiagnosticText(chunk)
        })
      }
      // Retain cancellation registration until every signal-consuming provisioning phase settles.
      try {
        return await provisionRecipeEnvironment(
          store,
          app.getPath('userData'),
          args,
          await getApprovedPluginVmRecipes(pluginService),
          {
            signal: controller?.signal,
            onStdout: (chunk) => sendProvisionEvent('stdout', chunk),
            onStderr: (chunk) => sendProvisionEvent('stderr', chunk)
          }
        )
      } finally {
        if (args.provisionId) {
          activeProvisionControllers.delete(args.provisionId)
        }
      }
    }
  )

  ipcMain.handle(
    'ephemeralVm:cancelProvision',
    (_event, args: { provisionId: string }): { cancelled: boolean } => {
      const controller = activeProvisionControllers.get(args.provisionId)
      if (!controller) {
        return { cancelled: false }
      }
      controller.abort()
      activeProvisionControllers.delete(args.provisionId)
      return { cancelled: true }
    }
  )
}
