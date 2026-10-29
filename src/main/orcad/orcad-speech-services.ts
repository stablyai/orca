import { ModelManager } from '../speech/model-manager'
import { openNodeSpeechDownloadRequest } from '../speech/node-speech-download-request'
import { canReadOpenAiSpeechApiKey } from '../speech/openai-api-key-store'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import { SttService } from '../speech/stt-service'

// Local speech needs the installed app recognizer supplied by orca serve.
export const orcadSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    // Headless key reads cannot open keychain prompts, so readiness may verify decryption.
    new ModelManager(customModelsDir, openNodeSpeechDownloadRequest, canReadOpenAiSpeechApiKey),
  createSttService: (models) => new SttService(models)
}
