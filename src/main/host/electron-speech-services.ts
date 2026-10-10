import { app } from 'electron'
import { join } from 'node:path'
import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import { PlaybackSuppressionService } from '../speech/playback-suppression-service'
import { PlaybackSuppressionRecoveryFile } from '../speech/playback-suppression-recovery-file'
import { createPlaybackSuppressionAdapter } from '../speech/playback-suppression-platform'

/** The desktop speech factories. Importing this file is what pulls Electron's net in. */
export const electronSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) => new ModelManager(customModelsDir),
  createSttService: (models) => new SttService(models),
  createPlaybackSuppressionService: () =>
    new PlaybackSuppressionService(
      createPlaybackSuppressionAdapter(process.platform, {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath
      }),
      new PlaybackSuppressionRecoveryFile(
        join(app.getPath('userData'), 'playback-suppression-recovery.json')
      )
    )
}
