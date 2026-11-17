import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL,
  type OrcaCloudEnvironmentBuildEvent
} from '../../shared/hosted-sandbox/hosted-environment-api'

export const orcaCloudEnvironmentsApi = {
  isConfigured: () => ipcRenderer.invoke('orcaCloudEnvironments:isConfigured'),
  list: () => ipcRenderer.invoke('orcaCloudEnvironments:list'),
  get: (envId) => ipcRenderer.invoke('orcaCloudEnvironments:get', envId),
  create: (input) => ipcRenderer.invoke('orcaCloudEnvironments:create', input),
  update: (envId, patch) => ipcRenderer.invoke('orcaCloudEnvironments:update', envId, patch),
  remove: (envId) => ipcRenderer.invoke('orcaCloudEnvironments:remove', envId),
  startBuild: (envId) => ipcRenderer.invoke('orcaCloudEnvironments:startBuild', envId),
  cancelBuild: (envId, buildId) =>
    ipcRenderer.invoke('orcaCloudEnvironments:cancelBuild', envId, buildId),
  activateBuild: (envId, buildId) =>
    ipcRenderer.invoke('orcaCloudEnvironments:activateBuild', envId, buildId),
  staleness: (envId, refresh) =>
    ipcRenderer.invoke('orcaCloudEnvironments:staleness', envId, refresh === true),
  watchBuild: (envId, buildId) =>
    ipcRenderer.invoke('orcaCloudEnvironments:watchBuild', envId, buildId),
  unwatchBuild: async (watchId) => {
    await ipcRenderer.invoke('orcaCloudEnvironments:unwatchBuild', watchId)
  },
  onBuildEvent: (callback: (event: OrcaCloudEnvironmentBuildEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: OrcaCloudEnvironmentBuildEvent): void =>
      callback(payload)
    ipcRenderer.on(ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL, listener)
  },
  readRepoSetupImports: (repoPath) =>
    ipcRenderer.invoke('orcaCloudEnvironments:readRepoSetupImports', repoPath)
} satisfies PreloadApi['orcaCloudEnvironments']
