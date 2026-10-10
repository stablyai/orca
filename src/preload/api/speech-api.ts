import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type {
  CloudSpeechKeyStatus,
  CloudSpeechKeyTestResult,
  CloudSpeechProviderId
} from '../../shared/cloud-speech-providers'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../shared/speech-types'

export type SpeechApi = {
  getCatalog: () => Promise<SpeechModelManifest[]>
  getModelStates: () => Promise<SpeechModelState[]>
  getOpenAiApiKeyStatus: () => Promise<{
    configured: boolean
    protection: SecretAtRestProtection | null
  }>
  saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
  clearOpenAiApiKey: () => Promise<{ configured: boolean }>
  getCloudKeyStatuses: () => Promise<CloudSpeechKeyStatus[]>
  /** Rejects with the provider's sanitized reason when verify is true and the key is refused. */
  saveCloudKey: (
    providerId: CloudSpeechProviderId,
    apiKey: string,
    verify: boolean
  ) => Promise<CloudSpeechKeyStatus>
  clearCloudKey: (providerId: CloudSpeechProviderId) => Promise<CloudSpeechKeyStatus>
  testCloudKey: (providerId: CloudSpeechProviderId) => Promise<CloudSpeechKeyTestResult>
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
