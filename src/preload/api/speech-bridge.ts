import { ipcRenderer } from 'electron'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../shared/speech-types'
import type { PreloadApi } from '../api-types'

export const speechApi = {
  getCatalog: (): Promise<SpeechModelManifest[]> => ipcRenderer.invoke('speech:getCatalog'),
  getModelStates: (): Promise<SpeechModelState[]> => ipcRenderer.invoke('speech:getModelStates'),
  getOpenAiApiKeyStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('speech:getOpenAiApiKeyStatus'),
  saveOpenAiApiKey: (apiKey: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('speech:saveOpenAiApiKey', apiKey),
  clearOpenAiApiKey: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('speech:clearOpenAiApiKey'),
  downloadModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:downloadModel', modelId),
  cancelDownload: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:cancelDownload', modelId),
  deleteModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:deleteModel', modelId),
  startDictation: (
    modelId: string,
    hotwords: string[] | undefined,
    sessionId: string
  ): Promise<void> => ipcRenderer.invoke('speech:startDictation', modelId, hotwords, sessionId),
  feedAudio: (samples: Float32Array, sampleRate: number, sessionId = 'desktop'): Promise<void> =>
    // Why: Float32Array is zeroed crossing the contextBridge/IPC boundary; wrap in a Buffer to preserve bytes.
    ipcRenderer.invoke(
      'speech:feedAudio',
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
      sampleRate,
      sessionId
    ),
  stopDictation: (sessionId = 'desktop'): Promise<void> =>
    ipcRenderer.invoke('speech:stopDictation', sessionId),

  onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechTranscriptEvent): void =>
      callback(data)
    ipcRenderer.on('speech:partial', listener)
    return () => ipcRenderer.removeListener('speech:partial', listener)
  },
  onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechTranscriptEvent): void =>
      callback(data)
    ipcRenderer.on('speech:final', listener)
    return () => ipcRenderer.removeListener('speech:final', listener)
  },
  onDownloadProgress: (
    callback: (data: { modelId: string; progress: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { modelId: string; progress: number }
    ): void => callback(data)
    ipcRenderer.on('speech:downloadProgress', listener)
    return () => ipcRenderer.removeListener('speech:downloadProgress', listener)
  },
  onReady: (callback: (data: SpeechLifecycleEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechLifecycleEvent): void =>
      callback(data)
    ipcRenderer.on('speech:ready', listener)
    return () => ipcRenderer.removeListener('speech:ready', listener)
  },
  onStopped: (callback: (data: SpeechLifecycleEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechLifecycleEvent): void =>
      callback(data)
    ipcRenderer.on('speech:stopped', listener)
    return () => ipcRenderer.removeListener('speech:stopped', listener)
  },
  onError: (callback: (data: SpeechErrorEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechErrorEvent): void =>
      callback(data)
    ipcRenderer.on('speech:error', listener)
    return () => ipcRenderer.removeListener('speech:error', listener)
  }
} satisfies PreloadApi['speech']
