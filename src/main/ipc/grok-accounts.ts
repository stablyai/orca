import { ipcMain } from 'electron'
import { getGrokAccountStatus } from '../grok-accounts/status'
import type { ManagedCliHomeAccountService } from '../provider-managed-homes/service'
import { registerManagedProviderHomeHandlers } from './provider-managed-home-handlers'

export function registerGrokAccountHandlers(service: ManagedCliHomeAccountService): void {
  ipcMain.handle('grokAccounts:getStatus', () => getGrokAccountStatus())
  registerManagedProviderHomeHandlers('grokAccounts', service, 'Grok')
}
