import { app } from 'electron'
import { join } from 'node:path'
import { ModelManager } from './model-manager'
import { SttService } from './stt-service'
import type { VoiceSettings } from '../../shared/speech-types'
import { createLinuxPlaybackSuppressionAdapter } from './playback-suppression-linux'
import {
  PlaybackSuppressionService,
  type PlaybackSuppressionAdapter
} from './playback-suppression-service'
import { PlaybackSuppressionRecoveryFile } from './playback-suppression-recovery-file'

type SpeechSettingsStore = {
  getSettings(): {
    voice?: VoiceSettings
  }
}

let modelManager: ModelManager | null = null
let sttService: SttService | null = null
let playbackSuppressionService: PlaybackSuppressionService | null = null

const unsupportedPlaybackSuppressionAdapter: PlaybackSuppressionAdapter = {
  getCapability: async () => false,
  snapshot: async () => {
    throw new Error('System audio muting is not supported on this operating system yet.')
  },
  setMuted: async () => {
    throw new Error('System audio muting is not supported on this operating system yet.')
  }
}

export function getSpeechModelManager(store: SpeechSettingsStore): ModelManager {
  if (!modelManager) {
    const settings = store.getSettings()
    const customDir = settings.voice?.modelsDir || undefined
    modelManager = new ModelManager(customDir || undefined)
  }
  return modelManager
}

export function getSpeechSttService(store: SpeechSettingsStore): SttService {
  if (!sttService) {
    sttService = new SttService(getSpeechModelManager(store))
  }
  return sttService
}

export function getPlaybackSuppressionService(): PlaybackSuppressionService {
  if (!playbackSuppressionService) {
    playbackSuppressionService = new PlaybackSuppressionService(
      process.platform === 'linux'
        ? createLinuxPlaybackSuppressionAdapter()
        : unsupportedPlaybackSuppressionAdapter,
      new PlaybackSuppressionRecoveryFile(
        join(app.getPath('userData'), 'playback-suppression-recovery.json')
      )
    )
  }
  return playbackSuppressionService
}
