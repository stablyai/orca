import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerEphemeralVmHost } from '../runtime/ephemeral-vm-host-registry'
import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PluginService } from '../plugins/plugin-service'
import { createEphemeralVmHost } from './ephemeral-vm-host'
export type { EphemeralVmProvisionIpcResult } from './ephemeral-vm-host'

export function registerEphemeralVmHandlers(store: Store, pluginService?: PluginService): void {
  const route = async (
    method: string,
    args: { ownerEnvironmentId?: string } | undefined,
    local: () => unknown
  ) => {
    if (!args?.ownerEnvironmentId) {
      return local()
    }
    // A legacy local recipe may own a workspace running on its paired guest.
    if ((method === 'resumeWorkspace' || method === 'suspendWorkspace') && 'workspaceId' in args) {
      const runtimes = await host.listRuntimes()
      if (
        runtimes.some(
          (entry) =>
            entry.workspaceId === args.workspaceId &&
            entry.runtimeEnvironmentId === args.ownerEnvironmentId
        )
      ) {
        return local()
      }
    }
    const { ownerEnvironmentId, ...params } = args
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      ownerEnvironmentId,
      `ephemeralVm.${method === 'provision' && 'workspaceRequest' in params ? 'provisionWorkspace' : method}`,
      method === 'listRuntimes' || method === 'listRecipeCatalog' ? undefined : params,
      method === 'provision' ? 30 * 60_000 : 60_000
    )
    if (!response.ok) {
      throw new Error(`Server-owned VM recipes: ${response.error.message}`)
    }
    return response.result
  }
  const host = createEphemeralVmHost(store, pluginService, () => app.getPath('userData'))
  registerEphemeralVmHost(host)
  for (const method of Object.keys(host)) {
    if (method === 'onProvisionEvent') {
      continue
    }
    ipcMain.removeHandler(`ephemeralVm:${method}`)
  }
  ipcMain.handle('ephemeralVm:listRecipes', (_event, args) =>
    route('listRecipes', args, () => host.listRecipes(args))
  )
  ipcMain.handle('ephemeralVm:listRecipeCatalog', (_event, args) =>
    route('listRecipeCatalog', args, () => host.listRecipeCatalog())
  )
  ipcMain.handle('ephemeralVm:doctor', (_event, args) =>
    route('doctor', args, () => host.doctor(args))
  )
  ipcMain.handle('ephemeralVm:provision', async (event, args) => {
    if (args.ownerEnvironmentId) {
      return route('provision', args, () => host.provision(args))
    }
    const unsubscribe = host.onProvisionEvent((progress) => {
      if (
        progress.provisionId === args.provisionId &&
        event?.sender &&
        !event.sender.isDestroyed?.()
      ) {
        event.sender.send('ephemeralVm:provisionEvent', progress)
      }
    })
    try {
      return await host.provision(args)
    } finally {
      unsubscribe()
    }
  })
  ipcMain.handle('ephemeralVm:adoptProvisionedRoot', (_event, args) =>
    route('adoptProvisionedRoot', args, () => host.adoptProvisionedRoot(args))
  )
  ipcMain.handle('ephemeralVm:cancelProvision', (_event, args) =>
    route('cancelProvision', args, () => host.cancelProvision(args))
  )
  ipcMain.handle('ephemeralVm:listRuntimes', (_event, args) =>
    route('listRuntimes', args, () => host.listRuntimes())
  )
  ipcMain.handle('ephemeralVm:attachWorkspace', (_event, args) =>
    route('attachWorkspace', args, () => host.attachWorkspace(args))
  )
  ipcMain.handle('ephemeralVm:cleanup', (_event, args) =>
    route('cleanup', args, () => host.cleanup(args))
  )
  ipcMain.handle('ephemeralVm:stopCleanup', (_event, args) =>
    route('stopCleanup', args, () => host.stopCleanup(args))
  )
  ipcMain.handle('ephemeralVm:suspendWorkspace', (_event, args) =>
    route('suspendWorkspace', args, () => host.suspendWorkspace(args))
  )
  ipcMain.handle('ephemeralVm:resumeWorkspace', (_event, args) =>
    route('resumeWorkspace', args, () => host.resumeWorkspace(args))
  )
  ipcMain.handle('ephemeralVm:getCleanupCommand', (_event, args) =>
    route('getCleanupCommand', args, () => host.getCleanupCommand(args))
  )
}
