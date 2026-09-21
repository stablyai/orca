import { ipcRenderer } from 'electron'
import type { ExternalAutomationManagerResult, PreloadApi } from '../api-types'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationRunsPage,
  AutomationRun,
  AutomationPrecheckResult
} from '../../shared/automations-types'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

export const automationsApi = {
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ): Promise<ExternalAutomationManagerResult> =>
    ipcRenderer.invoke('automations:listExternalManagerForOwner', request),
  listExternalRunsForOwner: (
    request: ScopedExternalManagerRunsRequest
  ): Promise<ExternalAutomationRunsPage> =>
    ipcRenderer.invoke('automations:listExternalRunsForOwner', request),
  createExternalForOwner: (request: ScopedExternalManagerCreateRequest): Promise<void> =>
    ipcRenderer.invoke('automations:createExternalForOwner', request),
  updateExternalForOwner: (request: ScopedExternalManagerUpdateRequest): Promise<void> =>
    ipcRenderer.invoke('automations:updateExternalForOwner', request),
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest): Promise<void> =>
    ipcRenderer.invoke('automations:runExternalActionForOwner', request),
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }): Promise<void> =>
    ipcRenderer.invoke('automations:retainExternalScopes', request),
  runPrecheck: (args: {
    automationId: string
    runId: string
  }): Promise<AutomationPrecheckResult | null> =>
    ipcRenderer.invoke('automations:runPrecheck', args),
  markDispatchResult: (result: AutomationDispatchResult): Promise<AutomationRun> =>
    ipcRenderer.invoke('automations:markDispatchResult', result),
  snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }): Promise<number> =>
    ipcRenderer.invoke('automations:snapshotWorkspaceName', args),
  rendererReady: (): Promise<void> => ipcRenderer.invoke('automations:rendererReady'),
  onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: AutomationDispatchRequest) =>
      callback(request)
    ipcRenderer.on('automations:dispatchRequested', listener)
    return () => ipcRenderer.removeListener('automations:dispatchRequested', listener)
  },
  onChanged: (callback: (payload: AutomationsChangedPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AutomationsChangedPayload) =>
      callback(payload)
    ipcRenderer.on('automations:changed', listener)
    return () => ipcRenderer.removeListener('automations:changed', listener)
  }
} satisfies PreloadApi['automations']
