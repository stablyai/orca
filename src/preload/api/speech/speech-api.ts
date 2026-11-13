import type { NativeChatEdgeSpeechRequest } from '../../../shared/native-chat/native-chat-speech'
import type { SecretAtRestProtection } from '../../../shared/secret-at-rest-protection'
import type { DictationCleanupResult } from '../../../shared/dictation-cleanup'
import type {
  DictationContext,
  OpenAiCompatibleSpeechProvider,
  OpenAiCompatibleSpeechProviderSummary,
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechPendingEvent,
  SpeechTranscriptEvent
} from '../../../shared/speech-types'

export type SpeechApi = {
  getCatalog: () => Promise<SpeechModelManifest[]>
  getModelStates: () => Promise<SpeechModelState[]>
  getOpenAiApiKeyStatus: () => Promise<{
    configured: boolean
    protection: SecretAtRestProtection | null
  }>
  saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
  clearOpenAiApiKey: () => Promise<{ configured: boolean }>
  /** Never returns the saved key. */
  getOpenAiCompatibleProvider: () => Promise<OpenAiCompatibleSpeechProviderSummary | null>
  /** A blank key keeps the saved one while the base URL is unchanged. */
  saveOpenAiCompatibleProvider: (provider: OpenAiCompatibleSpeechProvider) => Promise<void>
  clearOpenAiCompatibleProvider: () => Promise<void>
  downloadModel: (modelId: string) => Promise<void>
  cancelDownload: (modelId: string) => Promise<void>
  deleteModel: (modelId: string) => Promise<void>
  startDictation: (
    modelId: string,
    context: DictationContext | undefined,
    sessionId: string
  ) => Promise<void>
  /** Resolves true when this chunk filled a cloud session's upload cap. */
  feedAudio: (samples: Float32Array, sampleRate: number, sessionId?: string) => Promise<boolean>
  stopDictation: (sessionId?: string) => Promise<void>
  /** Desktop only. The paired web client keeps the system voice in the page. */
  synthesize?: (request: NativeChatEdgeSpeechRequest) => Promise<{ audioBase64: string }>
  cancelSynthesis?: () => Promise<void>
  /** Drops the session's audio and any text it hasn't returned yet, without transcribing the rest. */
  cancelDictation: (sessionId: string) => Promise<void>
  /** Absent in the paired web client: its host cleans up inside `speech.dictation.finish`. */
  cleanUpDictation?: (
    text: string,
    context: DictationContext | undefined,
    requestId: string
  ) => Promise<DictationCleanupResult>
  cancelDictationCleanup?: (requestId: string) => Promise<void>
  onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
  onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
  onSpeechPending: (callback: (data: SpeechPendingEvent) => void) => () => void
  onDownloadProgress: (
    callback: (data: { modelId: string; progress: number }) => void
  ) => () => void
  onReady: (callback: (data: SpeechLifecycleEvent) => void) => () => void
  onStopped: (callback: (data: SpeechLifecycleEvent) => void) => () => void
  onError: (callback: (data: SpeechErrorEvent) => void) => () => void
}
