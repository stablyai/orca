import { ipcRenderer } from 'electron'
import type {
  CloudSecretBatchResult,
  CloudSecretTarget,
  CloudSecretView,
  CloudSecretsEffective,
  CloudSecretsResult,
  CloudSecretsStatus
} from '../../shared/cloud-secrets/cloud-secrets-wire'

/** Desktop only. Values go in; only names, scopes and last-4 hints come back. */
export type CloudSecretsApi = {
  status: () => Promise<CloudSecretsStatus>
  list: (target: CloudSecretTarget) => Promise<CloudSecretsResult<CloudSecretView[]>>
  put: (request: {
    target: CloudSecretTarget
    name: string
    value: string
  }) => Promise<CloudSecretsResult<CloudSecretView>>
  remove: (request: {
    target: CloudSecretTarget
    name: string
  }) => Promise<CloudSecretsResult<true>>
  batch: (request: {
    target: CloudSecretTarget
    set?: Record<string, string>
    delete?: string[]
  }) => Promise<CloudSecretsResult<CloudSecretBatchResult>>
  effective: (request: { repo?: string }) => Promise<CloudSecretsResult<CloudSecretsEffective>>
  /** Best-effort nudge so a running workspace picks up new values now; the server also does it on write. */
  refreshEnv: (request: { runtimeEnvironmentId: string }) => Promise<CloudSecretsResult<boolean>>
}

export const cloudSecretsApi: CloudSecretsApi = {
  status: () => ipcRenderer.invoke('cloudSecrets:status'),
  list: (target) => ipcRenderer.invoke('cloudSecrets:list', target),
  put: (request) => ipcRenderer.invoke('cloudSecrets:put', request),
  remove: (request) => ipcRenderer.invoke('cloudSecrets:remove', request),
  batch: (request) => ipcRenderer.invoke('cloudSecrets:batch', request),
  effective: (request) => ipcRenderer.invoke('cloudSecrets:effective', request),
  refreshEnv: (request) => ipcRenderer.invoke('cloudSecrets:refreshEnv', request)
}
