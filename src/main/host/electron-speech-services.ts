import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'

/** The desktop speech factories. Importing this file is what pulls Electron's net in. */
export const electronSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) => new ModelManager(customModelsDir),
  createSttService: (models) => new SttService(models)
}
