import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  AutomationRun,
  AutomationUpdateInput
} from '../../shared/automations-types'
import {
  listExternalAutomationManagers,
  runExternalAutomationAction
} from '../automations/external-manager'

export function registerAutomationHandlers(store: Store, service: AutomationService): void {
  ipcMain.handle('automations:list', (): Automation[] => store.listAutomations())
  ipcMain.handle(
    'automations:listRuns',
    (_event, args?: { automationId?: string }): AutomationRun[] =>
      store.listAutomationRuns(args?.automationId)
  )
  ipcMain.handle('automations:listExternalManagers', (): Promise<ExternalAutomationManager[]> => {
    return listExternalAutomationManagers(store)
  })
  ipcMain.handle(
    'automations:runExternalAction',
    (_event, input: ExternalAutomationActionInput) => {
      return runExternalAutomationAction(input)
    }
  )
  ipcMain.handle(
    'automations:create',
    (_event, input: AutomationCreateInput): Automation => store.createAutomation(input)
  )
  ipcMain.handle(
    'automations:update',
    (_event, args: { id: string; updates: AutomationUpdateInput }): Automation =>
      store.updateAutomation(args.id, args.updates)
  )
  ipcMain.handle('automations:delete', (_event, args: { id: string }): void => {
    store.deleteAutomation(args.id)
  })
  ipcMain.handle(
    'automations:runNow',
    (_event, args: { id: string }): Promise<AutomationRun> => service.runNow(args.id)
  )
  ipcMain.handle(
    'automations:markDispatchResult',
    (_event, result: AutomationDispatchResult): AutomationRun => service.markDispatchResult(result)
  )
  ipcMain.handle('automations:rendererReady', (): void => {
    service.setRendererReady()
  })
}
