import { ipcRenderer } from 'electron'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlExchangeSdpResult,
  VoiceControlStartResult,
  VoiceControlState,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot,
  VoiceTranscriptEntry
} from '../../shared/voice-control-types'
import type { PreloadApi } from '../api-types'

export const voiceControlApi = {
  start: (): Promise<VoiceControlStartResult> => ipcRenderer.invoke('voice-control:start'),
  exchangeSdp: (sessionId: string, offerSdp: string): Promise<VoiceControlExchangeSdpResult> =>
    ipcRenderer.invoke('voice-control:exchangeSdp', sessionId, offerSdp),
  stop: (sessionId: string): Promise<void> => ipcRenderer.invoke('voice-control:stop', sessionId),
  getState: (): Promise<{ state: VoiceControlState; sessionId: string | null }> =>
    ipcRenderer.invoke('voice-control:getState'),
  getTranscript: (): Promise<VoiceTranscriptEntry[]> =>
    ipcRenderer.invoke('voice-control:getTranscript'),
  onStateChanged: (callback: (event: VoiceControlStateChangedEvent) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: VoiceControlStateChangedEvent
    ): void => callback(data)
    ipcRenderer.on('voice-control:stateChanged', listener)
    return () => ipcRenderer.removeListener('voice-control:stateChanged', listener)
  },
  onToolActivity: (callback: (event: VoiceControlToolActivityEvent) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: VoiceControlToolActivityEvent
    ): void => callback(data)
    ipcRenderer.on('voice-control:toolActivity', listener)
    return () => ipcRenderer.removeListener('voice-control:toolActivity', listener)
  },
  onAgentActivity: (callback: (event: VoiceControlAgentActivityEvent) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: VoiceControlAgentActivityEvent
    ): void => callback(data)
    ipcRenderer.on('voice-control:agentActivity', listener)
    return () => ipcRenderer.removeListener('voice-control:agentActivity', listener)
  },
  onTranscriptEntry: (callback: (entry: VoiceTranscriptEntry) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: VoiceTranscriptEntry): void =>
      callback(data)
    ipcRenderer.on('voice-control:transcriptEntry', listener)
    return () => ipcRenderer.removeListener('voice-control:transcriptEntry', listener)
  },
  sendUserText: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('voice-control:sendUserText', sessionId, text),
  onScreenSnapshotRequest: (callback: (requestId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string): void =>
      callback(requestId)
    ipcRenderer.on('voice-control:screenSnapshotRequest', listener)
    return () => ipcRenderer.removeListener('voice-control:screenSnapshotRequest', listener)
  },
  sendScreenSnapshot: (requestId: string, snapshot: VoiceScreenSnapshot): void => {
    ipcRenderer.send('voice-control:screenSnapshotResponse', { requestId, snapshot })
  },
  onSystemResume: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('voice-control:systemResume', listener)
    return () => ipcRenderer.removeListener('voice-control:systemResume', listener)
  }
} satisfies PreloadApi['voiceControl']
