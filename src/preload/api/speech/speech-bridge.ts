import type { NativeChatEdgeSpeechRequest } from '../../../shared/native-chat/native-chat-speech'
import type { SecretAtRestProtection } from '../../../shared/secret-at-rest-protection'
import type { DictationCleanupResult } from '../../../shared/dictation-cleanup'
import { ipcRenderer } from 'electron'
import type {
  DictationContext,
  OpenAiCompatibleSpeechProvider,
  OpenAiCompatibleSpeechProviderSummary,
  SpeechAudioPortMessage,
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechPendingEvent,
  SpeechTranscriptEvent
} from '../../../shared/speech-types'
import type { PreloadApi } from '../../api-types'

// On-device sessions get a port to the speech process, so their audio skips main.
const audioPorts = new Map<string, MessagePort>()

export const speechApi = {
  getCatalog: (): Promise<SpeechModelManifest[]> => ipcRenderer.invoke('speech:getCatalog'),
  getModelStates: (): Promise<SpeechModelState[]> => ipcRenderer.invoke('speech:getModelStates'),
  getOpenAiApiKeyStatus: (): Promise<{
    configured: boolean
    protection: SecretAtRestProtection | null
  }> => ipcRenderer.invoke('speech:getOpenAiApiKeyStatus'),
  saveOpenAiApiKey: (apiKey: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('speech:saveOpenAiApiKey', apiKey),
  clearOpenAiApiKey: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('speech:clearOpenAiApiKey'),
  getOpenAiCompatibleProvider: (): Promise<OpenAiCompatibleSpeechProviderSummary | null> =>
    ipcRenderer.invoke('speech:getOpenAiCompatibleProvider'),
  saveOpenAiCompatibleProvider: (provider: OpenAiCompatibleSpeechProvider): Promise<void> =>
    ipcRenderer.invoke('speech:saveOpenAiCompatibleProvider', provider),
  clearOpenAiCompatibleProvider: (): Promise<void> =>
    ipcRenderer.invoke('speech:clearOpenAiCompatibleProvider'),
  downloadModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:downloadModel', modelId),
  cancelDownload: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:cancelDownload', modelId),
  deleteModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('speech:deleteModel', modelId),
  startDictation: async (
    modelId: string,
    context: DictationContext | undefined,
    sessionId: string
  ): Promise<void> => {
    const { port1, port2 } = new MessageChannel()
    // Sent ahead of the start on the same pipe, so main holds it when the start lands.
    ipcRenderer.postMessage('speech:audioPort', sessionId, [port2])
    let directAudio = false
    try {
      const result: { directAudio?: boolean } | undefined = await ipcRenderer.invoke(
        'speech:startDictation',
        modelId,
        context,
        sessionId
      )
      directAudio = result?.directAudio === true
    } finally {
      if (directAudio) {
        audioPorts.set(sessionId, port1)
      } else {
        port1.close()
      }
    }
  },
  feedAudio: (
    samples: Float32Array,
    sampleRate: number,
    sessionId = 'desktop'
  ): Promise<boolean> => {
    const port = audioPorts.get(sessionId)
    if (port) {
      port.postMessage({ type: 'feed', samples, sampleRate } satisfies SpeechAudioPortMessage)
      // Only cloud sessions have an upload cap, and they never get a port.
      return Promise.resolve(false)
    }
    // Buffer preserves sample bytes across the contextBridge/IPC boundary.
    return ipcRenderer.invoke(
      'speech:feedAudio',
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
      sampleRate,
      sessionId
    )
  },
  stopDictation: (sessionId = 'desktop'): Promise<void> => {
    const port = audioPorts.get(sessionId)
    if (port) {
      audioPorts.delete(sessionId)
      // The speech process finishes the stream only after this, so the last frames land.
      port.postMessage({ type: 'end' } satisfies SpeechAudioPortMessage)
      port.close()
    }
    return ipcRenderer.invoke('speech:stopDictation', sessionId)
  },
  synthesize: (request: NativeChatEdgeSpeechRequest): Promise<{ audioBase64: string }> =>
    ipcRenderer.invoke('speech:synthesize', request),
  cancelSynthesis: (): Promise<void> => ipcRenderer.invoke('speech:cancelSynthesis'),
  cancelDictation: (sessionId: string): Promise<void> => {
    audioPorts.get(sessionId)?.close()
    audioPorts.delete(sessionId)
    return ipcRenderer.invoke('speech:cancelDictation', sessionId)
  },
  cleanUpDictation: (
    text: string,
    context: DictationContext | undefined,
    requestId: string
  ): Promise<DictationCleanupResult> =>
    ipcRenderer.invoke('speech:cleanUpDictation', { text, context, requestId }),
  cancelDictationCleanup: (requestId: string): Promise<void> =>
    ipcRenderer.invoke('speech:cancelDictationCleanup', requestId),

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
  onSpeechPending: (callback: (data: SpeechPendingEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeechPendingEvent): void =>
      callback(data)
    ipcRenderer.on('speech:pending', listener)
    return () => ipcRenderer.removeListener('speech:pending', listener)
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
