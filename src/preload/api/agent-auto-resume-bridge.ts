import { ipcRenderer } from 'electron'
import {
  AGENT_AUTO_RESUME_UPDATE_CHANNEL,
  type AgentAutoResumeSnapshot
} from '../../shared/agent-auto-resume-types'
import type { PreloadApi } from '../api-types'

export const agentAutoResumeApi = {
  get: (): Promise<AgentAutoResumeSnapshot> => ipcRenderer.invoke('agentAutoResume:get'),
  onUpdate: (callback: (snapshot: AgentAutoResumeSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AgentAutoResumeSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on(AGENT_AUTO_RESUME_UPDATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(AGENT_AUTO_RESUME_UPDATE_CHANNEL, listener)
  }
} satisfies PreloadApi['agentAutoResume']
