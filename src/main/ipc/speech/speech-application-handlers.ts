import type { SttService } from '../../speech/stt-service'
import {
  publishToDocuments,
  registerAppHandler,
  appWindowFor
} from '../app-registry/app-handler-registry'

import { dictationTermsFor } from '../../../shared/speech/dictation/dictation-dictionary'

import { SPEECH_MODEL_CATALOG } from '../../speech/model-catalog'
import { deleteLocalSpeechModel } from '../../speech/speech-model-deletion'
import { getSpeechModelManager } from '../../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey
} from '../../speech/openai-api-key-store'
import {
  saveVerifiedOpenAiCompatibleSpeechProvider,
  saveVerifiedOpenAiSpeechApiKey
} from '../../speech/openai-api-key-verification'
import {
  clearOpenAiCompatibleSpeechProvider,
  summarizeOpenAiCompatibleSpeechProvider
} from '../../speech/openai-compatible-speech-provider-store'
import type {
  DictationContext,
  OpenAiCompatibleSpeechProvider
} from '../../../shared/speech/speech-types'
import type { Store } from '../../persistence/loading-store/store'
import type { DictationCleanupResult } from '../../../shared/speech/dictation/dictation-cleanup'
import { cancelDictationCleanup, cleanUpDictatedText } from '../../speech/dictation-cleanup-service'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'

const MAX_CLEANUP_TEXT_LENGTH = 100_000

export function registerSpeechApplicationHandlers(
  store: Store,
  agentEnvResolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  resolveTranscriber: () => SttService
): void {
  registerAppHandler(
    'speech:cleanUpDictation',
    (
      _event,
      args: { text: string; context?: DictationContext; requestId: string }
    ): Promise<DictationCleanupResult> => {
      if (typeof args?.text !== 'string' || args.text.length > MAX_CLEANUP_TEXT_LENGTH) {
        return Promise.resolve({
          status: 'failed',
          reason: 'Dictated text is too long to clean up.'
        })
      }
      return cleanUpDictatedText(
        {
          text: args.text,
          terms: dictationTermsFor(store.getSettings().voice, {
            dictationTerms: args.context?.repoTerms,
            displayName: args.context?.repoName
          }),
          requestId: typeof args.requestId === 'string' ? args.requestId : undefined
        },
        { getSettings: () => store.getSettings(), getAgentEnvResolvers: () => agentEnvResolvers }
      )
    }
  )

  registerAppHandler('speech:cancelDictationCleanup', (_event, requestId: unknown) => {
    if (typeof requestId === 'string') {
      cancelDictationCleanup(requestId)
    }
  })

  registerAppHandler('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  registerAppHandler('speech:getModelStates', async () => {
    return getSpeechModelManager(store).getModelStates()
  })

  registerAppHandler('speech:getOpenAiApiKeyStatus', async () => {
    return {
      configured: await hasOpenAiSpeechApiKey(),
      protection: await getOpenAiSpeechApiKeyProtection()
    }
  })

  registerAppHandler('speech:saveOpenAiApiKey', async (_event, apiKey: string) => {
    await saveVerifiedOpenAiSpeechApiKey(apiKey)
    return { configured: true, protection: await getOpenAiSpeechApiKeyProtection() }
  })

  registerAppHandler('speech:clearOpenAiApiKey', async () => {
    await clearOpenAiSpeechApiKey()
    return { configured: false, protection: null }
  })

  registerAppHandler('speech:getOpenAiCompatibleProvider', async () => {
    try {
      return await summarizeOpenAiCompatibleSpeechProvider()
    } catch {
      return null
    }
  })

  registerAppHandler(
    'speech:saveOpenAiCompatibleProvider',
    async (_event, input: OpenAiCompatibleSpeechProvider) => {
      await saveVerifiedOpenAiCompatibleSpeechProvider(input)
    }
  )

  registerAppHandler('speech:clearOpenAiCompatibleProvider', async () => {
    await clearOpenAiCompatibleSpeechProvider()
  })

  registerAppHandler('speech:downloadModel', async (event, modelId: string) => {
    const manager = getSpeechModelManager(store)
    const document = appWindowFor(event)
    if (event.windowId === null) {
      return
    }
    const clearProgressCallback = manager.setProgressCallback((id, progress) => {
      if (!document.isDestroyed()) {
        publishToDocuments(
          'speech:downloadProgress',
          { modelId: id, progress },
          { sourceId: document.id }
        )
      }
    })
    // Scope process-wide model progress callbacks to the download/window lifetime to avoid retaining stale windows.
    let progressCallbackCleared = false
    const cleanupProgressCallback = (): void => {
      if (progressCallbackCleared) {
        return
      }
      progressCallbackCleared = true
      document.removeListener('destroyed', cleanupProgressCallback)
      clearProgressCallback()
    }
    document.once('destroyed', cleanupProgressCallback)
    try {
      await manager.downloadModel(modelId)
    } finally {
      cleanupProgressCallback()
    }
  })

  registerAppHandler('speech:cancelDownload', async (_event, modelId: string) => {
    getSpeechModelManager(store).cancelDownload(modelId)
  })

  registerAppHandler('speech:deleteModel', async (_event, modelId: string) => {
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: resolveTranscriber(),
      modelId
    })
  })
}
