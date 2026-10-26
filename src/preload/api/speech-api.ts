import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type {
  ElevenLabsAudioChunk,
  ElevenLabsSpeechRequest,
  ElevenLabsVoice,
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../shared/speech-types'

import type { StsTurnModelAsset } from '../../shared/sts-turn-models'

export type SpeechApi = {
  loadTurnModels?: () => Promise<StsTurnModelAsset[]>
  getCatalog: () => Promise<SpeechModelManifest[]>
  getModelStates: () => Promise<SpeechModelState[]>
  getOpenAiApiKeyStatus: () => Promise<{
    configured: boolean
    protection: SecretAtRestProtection | null
  }>
  saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
  clearOpenAiApiKey: () => Promise<{ configured: boolean }>
  getElevenLabsApiKeyStatus: () => Promise<{ configured: boolean }>
  saveElevenLabsApiKey: (key: string) => Promise<{ configured: boolean }>
  clearElevenLabsApiKey: () => Promise<{ configured: boolean }>
  listElevenLabsVoices: () => Promise<ElevenLabsVoice[]>
  synthesizeElevenLabs: (request: ElevenLabsSpeechRequest) => Promise<Uint8Array>
  streamElevenLabs?: (request: ElevenLabsSpeechRequest) => Promise<void>
  onElevenLabsAudio?: (callback: (data: ElevenLabsAudioChunk) => void) => () => void
  cancelElevenLabs: (requestId: string) => Promise<void>
  downloadModel: (modelId: string) => Promise<void>
  cancelDownload: (modelId: string) => Promise<void>
  deleteModel: (modelId: string) => Promise<void>
  startDictation: (
    modelId: string,
    hotwords: string[] | undefined,
    sessionId: string
  ) => Promise<void>
  feedAudio: (samples: Float32Array, sampleRate: number, sessionId?: string) => Promise<void>
  stopDictation: (sessionId?: string) => Promise<void>
  onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
  onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
  onDownloadProgress: (
    callback: (data: { modelId: string; progress: number }) => void
  ) => () => void
  onReady: (callback: (data: SpeechLifecycleEvent) => void) => () => void
  onStopped: (callback: (data: SpeechLifecycleEvent) => void) => () => void
  onError: (callback: (data: SpeechErrorEvent) => void) => () => void
}
