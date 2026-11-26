import { ipcRenderer } from 'electron'
import type { PipelineOwnerApi } from './pipeline-owner-api'

export const pipelineOwnerApi: PipelineOwnerApi = {
  publishTemplate: (input) => ipcRenderer.invoke('pipelineOwner:publishTemplate', input),
  disableTemplate: (input) => ipcRenderer.invoke('pipelineOwner:disableTemplate', input),
  resolveDecision: (input) => ipcRenderer.invoke('pipelineOwner:resolveDecision', input),
  resolveBudget: (input) => ipcRenderer.invoke('pipelineOwner:resolveBudget', input),
  discussBoundSession: (input) => ipcRenderer.invoke('pipelineOwner:discussBoundSession', input),
  synchronize: (input) => ipcRenderer.invoke('pipelineOwner:synchronize', input)
}
