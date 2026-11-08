import type { ExecutionHostId } from '../../shared/execution-host'
import { ipcRenderer } from 'electron'
import type { ExternalAutomationManagerResult, PreloadApi } from '../api-types'
import type { AutomationOwnerRef } from '../../shared/automations/ownership/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerListRequest
} from '../../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

export const automationsApi = {
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ): Promise<ExternalAutomationManagerResult> =>
    ipcRenderer.invoke('automations:listExternalManagerForOwner', request),
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest): Promise<void> =>
    ipcRenderer.invoke('automations:runExternalActionForOwner', request),
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }): Promise<void> =>
    ipcRenderer.invoke('automations:retainExternalScopes', request),
  snapshotWorkspaceName: (args: {
    workspaceId: string
    hostId: ExecutionHostId
    displayName: string
  }): Promise<number> => ipcRenderer.invoke('automations:snapshotWorkspaceName', args),
  onChanged: (callback: (payload: AutomationsChangedPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AutomationsChangedPayload) =>
      callback(payload)
    ipcRenderer.on('automations:changed', listener)
    return () => ipcRenderer.removeListener('automations:changed', listener)
  }
} satisfies PreloadApi['automations']
