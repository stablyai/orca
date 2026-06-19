import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationFolder,
  AutomationFolderCreateInput,
  AutomationFolderUpdateInput,
  AutomationPrecheckResult,
  ExternalAutomationCreateInput,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../shared/automations-types'
import {
  createExternalAutomation,
  listExternalAutomationManagers,
  listExternalAutomationRuns,
  runExternalAutomationAction,
  updateExternalAutomation
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
    'automations:listExternalRuns',
    (_event, input: ExternalAutomationRunsInput): Promise<ExternalAutomationRunsPage> => {
      return listExternalAutomationRuns(input)
    }
  )
  ipcMain.handle('automations:createExternal', (_event, input: ExternalAutomationCreateInput) => {
    return createExternalAutomation(input)
  })
  ipcMain.handle('automations:updateExternal', (_event, input: ExternalAutomationUpdateInput) => {
    return updateExternalAutomation(input)
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
  ipcMain.handle('automations:listFolders', (): AutomationFolder[] => store.listAutomationFolders())
  ipcMain.handle(
    'automations:createFolder',
    (_event, input: AutomationFolderCreateInput): AutomationFolder =>
      store.createAutomationFolder(input)
  )
  ipcMain.handle(
    'automations:updateFolder',
    (_event, args: { id: string; updates: AutomationFolderUpdateInput }): AutomationFolder =>
      store.updateAutomationFolder(args.id, args.updates)
  )
  ipcMain.handle('automations:deleteFolder', (_event, args: { id: string }): void => {
    store.deleteAutomationFolder(args.id)
  })
  ipcMain.handle(
    'automations:moveToFolder',
    // Why: a named channel over updateAutomation keeps the renderer + CLI move
    // intent legible, mirroring how runNow is a named channel over a store op.
    (_event, args: { automationId: string; folderId: string | null }): Automation =>
      store.updateAutomation(args.automationId, { folderId: args.folderId })
  )
  ipcMain.handle(
    'automations:runNow',
    (_event, args: { id: string }): Promise<AutomationRun> => service.runNow(args.id)
  )
  ipcMain.handle(
    'automations:runPrecheck',
    (
      _event,
      args: { automationId: string; runId: string }
    ): Promise<AutomationPrecheckResult | null> =>
      service.runPrecheck(args.automationId, args.runId)
  )
  ipcMain.handle(
    'automations:markDispatchResult',
    (_event, result: AutomationDispatchResult): Promise<AutomationRun> =>
      service.markDispatchResult(result)
  )
  ipcMain.handle(
    'automations:snapshotWorkspaceName',
    (_event, args: { workspaceId: string; displayName: string }): number =>
      store.snapshotAutomationRunWorkspaceDisplayName(args.workspaceId, args.displayName)
  )
  ipcMain.handle('automations:rendererReady', (): void => {
    service.setRendererReady()
  })
}
