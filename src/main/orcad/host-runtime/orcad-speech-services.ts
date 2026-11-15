import { ModelManager } from '../../speech/model-manager'
import { openNodeSpeechDownloadRequest } from '../../speech/node-speech-download-request'
import { canReadCloudSpeechCredentials } from '../../speech/cloud-transcription-target'
import type { SpeechServiceFactories } from '../../speech/speech-runtime-service'
import { SttService } from '../../speech/stt-service'
import { createSttGpuPolicy } from '../../speech/stt-gpu-failure-marker'
import { spawnSttWorkerWithCpuFallback } from '../../speech/stt-worker-cpu-fallback'
import { spawnSttForkedProcess } from '../../speech/stt-worker-forked-process'

// Local speech needs the installed app recognizer supplied by orca serve.
export const orcadSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    // Headless key reads cannot open keychain prompts, so readiness may verify decryption.
    new ModelManager(customModelsDir, openNodeSpeechDownloadRequest, canReadCloudSpeechCredentials),
  createSttService: (models, gpuEnabled) => {
    const gpu = createSttGpuPolicy(models.getModelsDir(), gpuEnabled)
    return new SttService(models, () => spawnSttWorkerWithCpuFallback(spawnSttForkedProcess, gpu))
  }
}
