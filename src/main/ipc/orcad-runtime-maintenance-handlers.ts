import { ipcMain } from 'electron'
import { registerManagedServerActions } from '../runtime/managed-server-actions-registry'
import { createManagedOrcadActions, type ManagedOrcadActionOptions } from './managed-orcad-actions'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeMaintenanceHandlers(options: ManagedOrcadActionOptions): void {
  const actions = createManagedOrcadActions(options)
  // Why: the CLI reaches these same actions over runtime RPC (managedServer.*).
  registerManagedServerActions(actions)
  ipcMain.handle(
    'runtimeEnvironments:updateOrcad',
    async (_event, args: { selector: string; force?: boolean }) =>
      actions.update(requiredString(args?.selector, 'Server'), args?.force === true)
  )
  ipcMain.handle('runtimeEnvironments:rollbackOrcad', async (_event, args: { selector: string }) =>
    actions.rollback(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:recoverOrcad',
    async (_event, args: { selector: string; acceptChangedState?: boolean }) =>
      actions.recover(requiredString(args?.selector, 'Server'), args?.acceptChangedState === true)
  )
  ipcMain.handle('runtimeEnvironments:stopOrcad', async (_event, args: { selector: string }) =>
    actions.stop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelOrcadStop',
    async (_event, args: { selector: string }) =>
      actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:forgetOrcad', async (_event, args: { selector: string }) =>
    actions.forget(requiredString(args?.selector, 'Server'))
  )
}
