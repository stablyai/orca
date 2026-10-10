import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../shared/speech-types'

export type SpeechApi = {
  getPlaybackSuppressionCapability: () => Promise<boolean>
  acquirePlaybackSuppression: (
    sessionId: string
  ) => Promise<{ active: true } | { active: false; reason: 'canceled' | 'unavailable' }>
  releasePlaybackSuppression: (sessionId: string) => Promise<void>
  getCatalog: () => Promise<SpeechModelManifest[]>
  getModelStates: () => Promise<SpeechModelState[]>
  getOpenAiApiKeyStatus: () => Promise<{
    configured: boolean
    protection: SecretAtRestProtection | null
  }>
  saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
  clearOpenAiApiKey: () => Promise<{ configured: boolean }>
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
